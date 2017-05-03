/**
 * Copyright 2017 IBM All Rights Reserved.
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

'use strict';

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var fs = require('fs');
var path = require('path');
var intercept = require('intercept-stdout');

var grpc = require('grpc');
var configtxProto = grpc.load(path.join(__dirname, '../../fabric-client/lib/protos/common/configtx.proto')).common;
var policiesProto = grpc.load(path.join(__dirname, '../../fabric-client/lib/protos/common/policies.proto')).common;
var commonProto = grpc.load(path.join(__dirname, '../../fabric-client/lib/protos/common/common.proto')).common;

var rewire = require('rewire');
var Block = rewire('fabric-client/lib/Block.js');

test('\n\n*** Block.js tests ***\n\n', (t) => {
	t.throws(
		() => {
			Block.decode(new Uint8Array(2));
		},
		/Block input data is not a byte buffer/,
		'Check input is a Buffer object'
	);

	// use the genesis block as input to test the decoders
	var data = fs.readFileSync(path.join(__dirname, '../fixtures/channel/twoorgs.genesis.block'));

	var block = Block.decode(data);
	t.pass('Genesis block parsed without error');

	t.equal(
		block.data.data[0].payload.data.config.channel_group.policies.Writers.policy.type,
		'IMPLICIT_META',
		'Test parsing of channel\'s Writers policy is of IMPLICIT_META type');

	// test that the SDK spits out a warning of the "MSP" policy type
	// during decode because it's not supported in v1.0 yet
	var output = '';

	let unhook = intercept(function (txt) {
		output += txt;
	});

	var decodeConfigPolicy = Block.__get__('decodeConfigPolicy');
	var mockPolicy = new policiesProto.Policy();
	mockPolicy.setType(policiesProto.Policy.PolicyType.SIGNATURE);
	decodeConfigPolicy({
		value: {
			getVersion: function() { return 0; },
			getModPolicy: function() { return {}; },
			policy: {
				type: policiesProto.Policy.PolicyType.MSP,
				policy: mockPolicy.toBuffer()
			}
		}
	});

	unhook();

	if (output.indexOf('warn') >= 0 && output.indexOf('[Block.js]: decodeConfigPolicy - found a PolicyType of MSP') >= 0) {
		t.pass('Successfully tested warn logging message about using the "MSP" policy type');
	} else {
		t.fail('Failed to warn logging message about using the "MSP" policy type');
	}

	var mockPolicy = new policiesProto.Policy();
	mockPolicy.setType(policiesProto.Policy.PolicyType.SIGNATURE);
	t.throws(
		() => {
			decodeConfigPolicy({
				value: {
					getVersion: function() { return 0; },
					getModPolicy: function() { return {}; },
					policy: {
						type: policiesProto.Policy.PolicyType.MSB, // setting to an invalid type
						policy: mockPolicy.toBuffer()
					}
				}
			});
		},
		/Unknown Policy type/,
		'Test throwing an error on unknown policy type'
	);

	t.end();
});