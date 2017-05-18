/*
 Copyright 2016, 2017 London Stock Exchange All Rights Reserved.

 Licensed under the Apache License, Version 2.0 (the 'License');
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

                http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an 'AS IS' BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

'use strict';

var utils = require('./utils.js');
var Remote = require('./Remote.js');
var BlockDecoder = require('./BlockDecoder.js');
var grpc = require('grpc');
var HashTable = require('hashtable');
var logger = utils.getLogger('EventHub.js');

var _events = grpc.load(__dirname + '/protos/peer/events.proto').protos;
var _common = grpc.load(__dirname + '/protos/common/common.proto').common;
var _ccTransProto = grpc.load(__dirname + '/protos/peer/transaction.proto').protos;
var _transProto = grpc.load(__dirname + '/protos/peer/transaction.proto').protos;
var _responseProto = grpc.load(__dirname + '/protos/peer/proposal_response.proto').protos;
var _ccProposalProto = grpc.load(__dirname + '/protos/peer/proposal.proto').protos;
var _ccEventProto = grpc.load(__dirname + '/protos/peer/chaincode_event.proto').protos;

var _validation_codes = {};
var keys = Object.keys(_transProto.TxValidationCode);
for(var i = 0;i<keys.length;i++) {
	let new_key = _transProto.TxValidationCode[keys[i]];
	_validation_codes[new_key] = keys[i];
}

var _header_types = {};
keys = Object.keys(_common.HeaderType);
for(var j in keys) {
	let new_key = _common.HeaderType[keys[j]];
	_header_types[new_key] = keys[j];
}
/*
 * The ChainCodeCBE is used internal to the EventHub to hold chaincode
 * event registration callbacks.
 */
var ChainCodeCBE = class {
	/*
	 * Constructs a chaincode callback entry
	 *
	 * @param {string} ccid - chaincode id
	 * @param {string} eventNameFilter - The regex used to filter events
	 * @param {function} onEvent - Callback for filter matches
	 * @param {function} onError - Callback for connection errors
	 */
	constructor(ccid, eventNameFilter, onEvent, onError) {
		// chaincode id
		this.ccid = ccid;
		// event name regex filter
		this.eventNameFilter = new RegExp(eventNameFilter);
		// callback function to invoke on successful filter match
		this.onEvent = onEvent;
		// callback function to invoke on a connection failure
		this.onError = onError;
	}
};

/**
 * The EventHub class is used to distribute events from an
 * event source(peer)
 * @class
 */
var EventHub = class {

	/**
	 * Constructs an unconnected EventHub
	 *
	 * @param {Client} clientContext An instance of the Client class
	 * which has already been initialzed with a userContext.
	 *
	 */

	constructor(clientContext) {
		logger.debug('const ');
		// hashtable of clients registered for chaincode events
		this.chaincodeRegistrants = new HashTable();
		// set of clients registered for block events
		this.block_registrant_count = 1;
		this.blockOnEvents = new HashTable();
		this.blockOnErrors = new HashTable();
		// hashtable of clients registered for transactional events
		this.transactionOnEvents = new HashTable();
		this.transactionOnErrors = new HashTable();
		// peer node to connect to
		this.ep = null;
		// grpc event client interface
		this._client = null;
		// grpc chat streaming interface
		this.stream = null;
		// fabric connection state of this eventhub
		this.connected = false;
		// should this event hub reconnect on registrations
		this.force_reconnect = true;
		// reference to the client instance holding critical context such as signing identity
		if (typeof clientContext === 'undefined' || clientContext === null || clientContext === '')
			throw new Error('Missing required argument: clientContext');

		if (typeof clientContext.getUserContext !== 'function')
			throw new Error('Invalid clientContext argument: missing required function "getUserContext"');

		if (typeof clientContext.getUserContext() === 'undefined' || clientContext.getUserContext() === null)
			throw new Error('The clientContext has not been properly initialized, missing userContext');

		this._clientContext = clientContext;
	}

	/**
	 * Set peer url for event source<p>
	 * Note: Only use this if creating your own EventHub. The chain
	 * class creates a default eventHub that most Node clients can
	 * use (see eventHubConnect, eventHubDisconnect and getEventHub).
	 * @param {string} peeraddr peer url
	 * @param {object} opts An Object that may contain options to pass to grpcs calls
	 * <br>- pem {string} The certificate file, in PEM format,
	 *    to use with the gRPC protocol (that is, with TransportCredentials).
	 *    Required when using the grpcs protocol.
	 * <br>- ssl-target-name-override {string} Used in test environment only, when the server certificate's
	 *    hostname (in the 'CN' field) does not match the actual host endpoint that the server process runs
	 *    at, the application can work around the client TLS verify failure by setting this property to the
	 *    value of the server certificate's hostname
	 * <br>- any other standard grpc stream options will be passed to the grpc service calls directly
	 */

	setPeerAddr(peerUrl, opts) {
		logger.debug('setPeerAddr -  %s',peerUrl);
		this.ep = new Remote(peerUrl, opts);
	}

	/**
	 * Get connected state of eventhub
	 * @returns true if connected to event source, false otherwise
	 */
	isconnected() {
		return this.connected;
	}

	/**
	 * Establishes connection with peer event source
	 */
	connect(){
		this._connect();
	}

	/*
	 * Internal use only
	 * Establishes connection with peer event source
	 * @param {boolean} force - internal use only, will reestablish the
	 *                  the connection to the peer event hub
	 */
	_connect(force) {
		logger.debug('connect - start');
		if (!force && this.connected) {
			logger.debug('connect - end - already conneted');
			return;
		}
		if (!this.ep) throw Error('Must set peer address before connecting.');

		var self = this; // for callback context

		var send_timeout = setTimeout(function(){
			logger.error('connect - timed out after:%s', self.ep._request_timeout);
			self.disconnect();
		}, self.ep._request_timeout);


		this._client = new _events.Events(this.ep._endpoint.addr, this.ep._endpoint.creds, this.ep._options);
		this.stream = this._client.chat();
		this.connected = true;

		this.stream.on('data', function(event) {
			clearTimeout(send_timeout);
			var state = self.stream.call.channel_.getConnectivityState();
			logger.debug('connect - on.data - grpc stream state :%s',state);
			if (event.Event == 'block') {
				var block = BlockDecoder.decodeBlock(event.block);
				self._processBlockOnEvents(block);
				self._processTxOnEvents(block);
				self._processChainCodeOnEvents(block);
			}
			else if (event.Event == 'register'){
				logger.debug('connect - register event received');
			}
			else if (event.Event == 'unregister'){
				if(self.connected) self.disconnect();
				logger.debug('connect - unregister event received');
			}
			else {
				logger.debug('connect - unknown event %s',event.Event);
			}
		});
		this.stream.on('end', function() {
			clearTimeout(send_timeout);
			var state = self.stream.call.channel_.getConnectivityState();
			logger.debug('connect - on.end - grpc stream state :%s',state);
			if(self.connected) self.disconnect();
		});
		this.stream.on('error', function() {
			clearTimeout(send_timeout);
			var state = self.stream.call.channel_.getConnectivityState();
			logger.debug('connect - on.error - grpc stream state :%s',state);
			if(self.connected) self.disconnect();
		});

		this._sendRegistration(true);
		logger.debug('connect - end');
	}

	/**
	 * Disconnects the connection to the peer event source.
	 * Will close all event listeners and send an `Error` to
	 * all listeners that provided an "onError" callback.
	 */
	disconnect() {
		this.connected = false;
		this._closeAllCallbacks(new Error('EventHub has been shutdown'));
		if(this.stream) {
			this._sendRegistration(false);
			this.stream.end();
		}
	}

	/*
	 * Internal method
	 * Builds a signed event registration
	 * and sends it to the peer's event hub.
	 */
	_sendRegistration(register) {
		var user = this._clientContext.getUserContext();
		var signedEvent = new _events.SignedEvent();
		var event = new _events.Event();
		var reg = {events: [{event_type: 'BLOCK'}]};

		if(register) {
			event.setRegister(reg);
		}
		else {
			event.setUnregister(reg);
		}

		event.setCreator(user.getIdentity().serialize());
		signedEvent.setEventBytes(event.toBuffer());
		var sig = user.getSigningIdentity().sign(event.toBuffer());
		signedEvent.setSignature(Buffer.from(sig));
		this.stream.write(signedEvent);
	}

	/*
	 * Internal method to close out all callbacks
	 * Sends an error to all registered event onError callbacks
	 */
	_closeAllCallbacks(err) {
		logger.debug('_closeAllCallbacks - start');

		var closer = function(key, cb) {
			logger.debug('_closeAllCallbacks - closing this callback %s',key);
			cb(err);
		};

		logger.debug('_closeAllCallbacks - blockOnErrors %s',this.blockOnErrors.size());
		this.blockOnErrors.forEach(closer);
		this.blockOnEvents.clear();
		this.blockOnErrors.clear();

		logger.debug('_closeAllCallbacks - transactionOnErrors %s',this.transactionOnErrors.size());
		this.transactionOnErrors.forEach(closer);
		this.transactionOnEvents.clear();
		this.transactionOnErrors.clear();

		var cc_closer = function(key, cbtable) {
			cbtable.forEach(function(cbe) {
				logger.debug('_closeAllCallbacks - closing this chaincode event %s %s',cbe.ccid, cbe.eventNameFilter);
				if(cbe.onError) {
					cbe.onError(err);
				}
			});
		};

		logger.debug('_closeAllCallbacks - chaincodeRegistrants %s',this.chaincodeRegistrants.size());
		this.chaincodeRegistrants.forEach(cc_closer);
		this.chaincodeRegistrants.clear();
	}

	/*
	 * Internal method
	 * checks for a connection and will restart
	 */
	_checkConnection(throw_error, force_reconnect) {
		var state = 0;
		if(this.stream) {
			state = this.stream.call.channel_.getConnectivityState();
		}
		if(this.connected) {
			logger.debug('_checkConnection - this hub %s is connected with stream channel state %s', this.ep.getUrl(), state);
		}
		else {
			logger.debug('_checkConnection - this hub %s is not connected with stream channel state %s', this.ep.getUrl(), state);
			if(throw_error) {
				throw new Error('The event hub has not been connected to the event source');
			}
		}

		if(force_reconnect) {
			try {
				var is_paused = this.stream.isPaused();
				logger.debug('_checkConnection - grpc isPaused :%s',is_paused);
				if(is_paused) {
					this.stream.resume();
					logger.debug('_checkConnection - grpc resuming ');
				}
				var state = this.stream.call.channel_.getConnectivityState();
				logger.debug('_checkConnection - grpc stream state :%s',state);
				if(state != 2) {
					// try to reconnect
					this._connect(true);
				}
			}
			catch(error) {
				logger.error('_checkConnection - error ::' + error.stack ? error.stack : error);
				this.disconnect();
				throw new Error('Event hub is not connected ');
			}
		}
	}

	/**
	 * Register a callback function to receive chaincode events.
	 * This EventHub instance must be connected to a remote
	 * peer's event hub before registering for events by calling
	 * the "connect()" method.
	 * @param {string} ccid - string chaincode id
	 * @param {string} eventname - string The regex string used to filter events
	 * @param {function} onEvent - callback function for filter matches
	 * that takes a single parameter which is a json object representation
	 * of type "message ChaincodeEvent" from lib/proto/chaincode_event.proto
	 * @param {function} onError - optional callback function to be notified when this
	 * event hub is shutdown.
	 * @returns {object} ChainCodeCBE object that should be treated as an opaque
	 * handle used to unregister (see unregisterChaincodeEvent)
	 */
	registerChaincodeEvent(ccid, eventname, onEvent, onError) {
		logger.debug('registerChaincodeEvent - start');
		if(!ccid) {
			throw new Error('Missing "ccid" parameter');
		}
		if(!eventname) {
			throw new Error('Missing "eventname" parameter');
		}
		if(!onEvent) {
			throw new Error('Missing "onEvent" parameter');
		}
		var have_error_cb = onError ? true : false;
		// when there is no error callback throw an error
		// when this hub is not connected
		this._checkConnection(!have_error_cb, false);

		var cbe = new ChainCodeCBE(ccid, eventname, onEvent, onError);
		var cbtable = this.chaincodeRegistrants.get(ccid);
		if (!cbtable) {
			cbtable = new Set();
			this.chaincodeRegistrants.put(ccid, cbtable);
		}
		cbtable.add(cbe);

		// when there is an error callback try to reconnect this
		// event hub if is not connected
		if(have_error_cb) {
			this._checkConnection(false, this.force_reconnect);
		}

		return cbe;
	}

	/**
	 * Unregister chaincode event registration
	 * @param {object} cbe - ChainCodeCBE handle return from call to
	 * registerChaincodeEvent.
	 */
	unregisterChaincodeEvent(cbe) {
		logger.debug('unregisterChaincodeEvent - start');
		if(!cbe) {
			throw new Error('Missing "cbe" parameter');
		}
		var cbtable = this.chaincodeRegistrants.get(cbe.ccid);
		if (!cbtable) {
			logger.debug('No event registration for ccid %s ', cbe.ccid);
			return;
		}
		cbtable.delete(cbe);
		if (cbtable.size <= 0) {
			this.chaincodeRegistrants.remove(cbe.ccid);
		}
	}

	/**
	 * Register a callback function to receive block events.
	 * This EventHub instance must be connected to a remote
	 * peer's event hub before registering for events by calling
	 * the "connect()" method.
	 * @param {function} onEvent Function that takes a single parameter
	 * which is a JSON object representation of type GRPC message "Block"
	 * from lib/proto/common/common.proto.
	 * @see {@link Block}
	 * @param {function} onError - optional callback function to be notified when this
	 * event hub is shutdown.
	 * @returns {int} This is the block registration number that must be
	 * used to unregister (see unregisterBlockEvent)
	 */
	registerBlockEvent(onEvent, onError) {
		logger.debug('registerBlockEvent - start');
		if(!onEvent) {
			throw new Error('Missing "onEvent" parameter');
		}
		var have_error_cb = onError ? true : false;
		// when there is no error callback throw and error
		// when this hub is not connected
		this._checkConnection(!have_error_cb, false);

		var block_registration_number = this.block_registrant_count++;
		this.blockOnEvents.put(block_registration_number, onEvent);

		// when there is an error callback try to reconnect this
		// event hub if is not connected
		if(have_error_cb) {
			this.blockOnErrors.put(block_registration_number, onError);
			this._checkConnection(false, this.force_reconnect);
		}

		return block_registration_number;
	}

	/**
	 * Unregister the block event listener with the block
	 * registration number.
	 * @param {int} The block registration number that was returned
	 * during registration.
	 */
	unregisterBlockEvent(block_registration_number) {
		logger.debug('unregisterBlockEvent - start  %s',block_registration_number);
		if(!block_registration_number) {
			throw new Error('Missing "block_registration_number" parameter');
		}
		this.blockOnEvents.remove(block_registration_number);
		this.blockOnErrors.remove(block_registration_number);
	}

	/**
	 * Register a callback function to receive transactional events.
	 * This EventHub instance must be connected to a remote
	 * peer's event hub before registering for events by calling
	 * the "connect()" method.
	 * @param {string} txid string transaction id
	 * @param {function} onEvent Function that takes a parameter which
	 * is a json object representation of type "message Transaction"
	 * from lib/proto/fabric.proto and a parameter which is a boolean
	 * that indicates if the transaction is invalid (true=invalid)
	 * @param {function} onError - optional callback function to be notified when this
	 * event hub is shutdown.
	 */
	registerTxEvent(txid, onEvent, onError) {
		logger.debug('registerTxEvent txid ' + txid);
		if(!txid) {
			throw new Error('Missing "txid" parameter');
		}
		if(!onEvent) {
			throw new Error('Missing "onEvent" parameter');
		}
		var have_error_cb = onError ? true : false;
		// when there is no onError callback throw and error
		// when this hub is not connected
		this._checkConnection(!have_error_cb, false);

		this.transactionOnEvents.put(txid, onEvent);

		// when there is an onError callback try to reconnect this
		// event hub if is not connected
		if(have_error_cb) {
			this.transactionOnErrors.put(txid, onError);
			this._checkConnection(false, this.force_reconnect);
		}
	}

	/**
	 * Unregister transactional event registration.
	 * @param txid string transaction id
	 */
	unregisterTxEvent(txid) {
		logger.debug('unregisterTxEvent txid ' + txid);
		if(!txid) {
			throw new Error('Missing "txid" parameter');
		}
		this.transactionOnEvents.remove(txid);
		this.transactionOnErrors.remove(txid);
	}

	/*
	 * private internal method for processing block events
	 * @param {object} block protobuf object
	 */
	_processBlockOnEvents(block) {
		logger.debug('_processBlockOnEvents block=%s', block.header.number);
		if(this.blockOnEvents.size() == 0) {
			logger.debug('_processBlockOnEvents - no registered block event "listeners"');
			return;
		}

		// send to all registered block listeners
		this.blockOnEvents.forEach(function(key, cb) {
			cb(block);
		});
	}

	/*
	 * private internal method for processing tx events
	 * @param {object} block protobuf object which might contain the tx from the fabric
	 */
	_processTxOnEvents(block) {
		logger.debug('_processTxOnEvents block=%s', block.header.number);
		if(this.transactionOnEvents.size() == 0) {
			logger.debug('_processTxOnEvents - no registered transaction event "listeners"');
			return;
		}

		var txStatusCodes = block.metadata.metadata[_common.BlockMetadataIndex.TRANSACTIONS_FILTER];

		for (var index=0; index < block.data.data.length; index++) {
			logger.debug('_processTxOnEvents - trans index=%s',index);
			var channel_header = block.data.data[index].payload.header.channel_header;
			var val_code = convertValidationCode(txStatusCodes[index]);
			logger.debug('_processTxOnEvents - txid=%s  val_code=%s', channel_header.tx_id, val_code);
			var cb = this.transactionOnEvents.get(channel_header.tx_id);
			if (cb){
				logger.debug('_processTxOnEvents - about to stream the transaction call back for code=%s tx=%s', val_code, channel_header.tx_id);
				cb(channel_header.tx_id, val_code);
			}
		}
	};

	/*
	 * private internal method for processing chaincode events
	 * @param {object} block protobuf object which might contain the chaincode event from the fabric
	 */
	_processChainCodeOnEvents(block) {
		logger.debug('_processChainCodeOnEvents block=%s', block.header.number);
		if(this.chaincodeRegistrants.size() == 0) {
			logger.debug('_processChainCodeOnEvents - no registered chaincode event "listeners"');
			return;
		}

		for (var index=0; index < block.data.data.length; index++) {
			logger.debug('_processChainCodeOnEvents - trans index=%s',index);
			try {
				var env = block.data.data[index];
				var payload = env.payload;
				var channel_header = payload.header.channel_header;
				if (channel_header.type === _header_types[3]) {
					var tx = payload.data;
					var chaincodeActionPayload = tx.actions[0].payload;
					var propRespPayload = chaincodeActionPayload.action.proposal_response_payload;
					var caPayload = propRespPayload.extension;
					var ccEvent = caPayload.events;
					logger.debug('_processChainCodeOnEvents - ccEvent %s',ccEvent);
					var cbtable = this.chaincodeRegistrants.get(ccEvent.chaincode_id);
					if (!cbtable) {
						return;
					}
					cbtable.forEach(function(cbe) {
						if (cbe.eventNameFilter.test(ccEvent.event_name)) {
							cbe.onEvent(ccEvent);
						}
					});
				}
			} catch (err) {
				logger.error('on.data - Error unmarshalling transaction=', err);
			}
		}
	};
};

function convertValidationCode(code) {
	return _validation_codes[code];
}

module.exports = EventHub;