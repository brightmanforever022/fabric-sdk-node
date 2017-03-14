/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var hfc = require('fabric-client');
var util = require('util');
var fs = require('fs');
var path = require('path');
var testUtil = require('../unit/util.js');
var utils = require('fabric-client/lib/utils.js');
var Orderer = require('fabric-client/lib/Orderer.js');
var Peer = require('fabric-client/lib/Peer.js');

var client = new hfc();
var chain = client.newChain(testUtil.END2END.channel);
hfc.addConfigFile(path.join(__dirname, './config.json'));
var ORGS = hfc.getConfigSetting('test-network');
chain.addOrderer(new Orderer(ORGS.orderer));
var org = 'org1';
var orgName = ORGS[org].name;
for (let key in ORGS[org]) {
	if (ORGS[org].hasOwnProperty(key)) {
		if (key.indexOf('peer') === 0) {
			let peer = new Peer(ORGS[org][key].requests);
			chain.addPeer(peer);
		}
	}
}

var logger = utils.getLogger('NEW CHAIN');
hfc.setConfigSetting('hfc-logging', '{"debug":"console"}');

var keyValStorePath = testUtil.KVS;
var the_user = null;
var tx_id = null;
var nonce = null;

//
//Orderer via member send chain create
//
//Attempt to send a request to the orderer with the sendCreateChain method - fail
// fail due to chain already exist
//
test('\n\n** TEST ** new chain - chain.createChannel() fail due to already exist', function(t) {
	//
	// Create and configure the test chain
	//

	hfc.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)}
	)
	.then(
		function (store) {
			client.setStateStore(store);
			return testUtil.getSubmitter(client, t, org);
		}
	)
	.then(
		function(admin) {
			t.pass('Successfully enrolled user \'admin\'');
			the_user = admin;

			// readin the envelope to send to the orderer
			return readFile('./test/fixtures/channel/mychannel.tx');
		},
		function(err) {
			t.fail('Failed to enroll user \'admin\'. ' + err);
			t.end();
		}
	)
	.then(
		function(data) {
			t.pass('Successfully read file');
			//console.log('envelope contents ::'+JSON.stringify(data));
			var request = {
				envelope : data
			};
			// send to orderer
			return chain.createChannel(request);
		},
		function(err) {
			t.fail('Failed to read file :: ' + err);
			t.end();
		}
	)
	.then(
		function(response) {
			t.fail('Failed to get error. Response code: ' + response && response.status ? response.status : '');
			t.end();
		},
		function(err) {
			t.pass('Got back failure error. Error code: ' + err);
			t.end();
		}
	)
	.catch(function(err) {
		t.pass('Failed request. ' + err);
		t.end();
	});
});

function readFile(path) {
	return new Promise(function(resolve, reject) {
		fs.readFile(path, function(err, data) {
			if (err) {
				reject(err);
			} else {
				resolve(data);
			}
		});
	});
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
