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

var testUtil = require('../../unit/util.js');
var utils = require('fabric-client/lib/utils.js');
var Orderer = require('fabric-client/lib/Orderer.js');

var the_user = null;

var logger = utils.getLogger('create-channel');

hfc.addConfigFile(path.join(__dirname, './config.json'));
var ORGS = hfc.getConfigSetting('test-network');

//
//Attempt to send a request to the orderer with the sendCreateChain method
//
test('\n\n***** End-to-end flow: create channel *****\n\n', function(t) {
	//
	// Create and configure the test chain
	//
	var client = new hfc();
	var chain = client.newChain('mychannel');
	chain.addOrderer(new Orderer(ORGS.orderer));

	// Acting as a client in org1 when creating the channel
	var org = ORGS.org1.name;

	hfc.newDefaultKeyValueStore({
		path: testUtil.storePathForOrg(org)
	})
	.then((store) => {
		client.setStateStore(store);
		return testUtil.getSubmitter(client, t, 'org1');
	})
	.then((admin) => {
		t.pass('Successfully enrolled user \'admin\'');
		the_user = admin;

		//FIXME: temporary fix until mspid is configured into Chain
		the_user.mspImpl._id = ORGS.org1.mspid;

		// readin the envelope to send to the orderer
		return readFile('./test/fixtures/channel/mychannel.tx');
	}, (err) => {
		t.fail('Failed to enroll user \'admin\'. ' + err);
		t.end();
	})
	.then((data) => {
		t.pass('Successfully read file');
		var request = {
			envelope : data
		};
		// send to orderer
		return chain.createChannel(request);
	}, (err) => {
		t.fail('Failed to read file for channel template: ' + err);
		t.end();
	})
	.then((response) => {
		logger.debug(' response ::%j',response);

		if (response && response.status === 'SUCCESS') {
			t.pass('Successfully created the channel.');
			return sleep(5000);
		} else {
			t.fail('Failed to create the channel. ');
			t.end();
		}
	}, (err) => {
		t.fail('Failed to initialize the channel: ' + err.stack ? err.stack : err);
		t.end();
	})
	.then((nothing) => {
		t.pass('Successfully waited to make sure new channel was created.');
		t.end();
	}, (err) => {
		t.fail('Failed to sleep due to error: ' + err.stack ? err.stack : err);
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
