/*
 Copyright 2016 IBM All Rights Reserved.

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

	  http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

'use strict';

var api = require('../api.js');
var utils = require('../utils');
var jsrsa = require('jsrsasign');
var asn1 = jsrsa.asn1;
var path = require('path');
var grpc = require('grpc');
var _caProto = grpc.load(path.join(__dirname, '../../lib/protos/ca.proto')).protos;

/**
 * This is the default implementation of a member services client.
 *
 * @class
 */
var MemberServices = class extends api.MemberServices {

	/**
	 * constructor
	 *
	 * @param {string} url The endpoint URL for the member services of the form: "grpc://host:port" or "grpcs://host:port"
	 * @param {buffer} pem The client certificate
	 */
	constructor(url, pem) {
		super();

		var ep = new utils.Endpoint(url,pem);
		var options = {
			'grpc.ssl_target_name_override' : 'tlsca',
			'grpc.default_authority': 'tlsca'
		};

		this._ecaaClient = new _caProto.ECAA(ep.addr, ep.creds, options);
		this._ecapClient = new _caProto.ECAP(ep.addr, ep.creds, options);
		this._tcapClient = new _caProto.TCAP(ep.addr, ep.creds, options);
		this._tlscapClient = new _caProto.TLSCAP(ep.addr, ep.creds, options);
		this.cryptoPrimitives = utils.getCryptoSuite();
	}

	/**
	 * Get the security level
	 * @returns The security level
	 * @ignore
	 */
	getSecurityLevel() {
		return this.cryptoPrimitives.getSecurityLevel();
	}

	/**
	 * Set the security level
	 * @params securityLevel The security level
	 * @ignore
	 */
	setSecurityLevel(securityLevel) {
		this.cryptoPrimitives.setSecurityLevel(securityLevel);
	}

	/**
	 * Get the hash algorithm
	 * @returns {string} The hash algorithm
	 * @ignore
	 */
	getHashAlgorithm() {
		return this.cryptoPrimitives.getHashAlgorithm();
	}

	/**
	 * Set the hash algorithm
	 * @params hashAlgorithm The hash algorithm ('SHA2' or 'SHA3')
	 * @ignore
	 */
	setHashAlgorithm(hashAlgorithm) {
		this.cryptoPrimitives.setHashAlgorithm(hashAlgorithm);
	}

	getCrypto() {
		return this.cryptoPrimitives;
	}

	/**
	 * Register the member and return an enrollment secret.
	 * @param {Object} req Registration request with the following fields: enrollmentID, roles, registrar
	 * @param {Member} registrar The identity of the registrar (i.e. who is performing the registration)
	 * @returns Promise for the enrollmentSecret
	 * @ignore
	 */
	register(req, registrar) {
		var self = this;

		return new Promise(function(resolve, reject) {
			if (!req.enrollmentID) {
				reject(new Error('missing req.enrollmentID'));
				return;
			}

			if (!registrar) {
				reject(new Error('chain registrar is not set'));
				return;
			}

			var protoReq = new _caProto.RegisterUserReq();
			protoReq.setId({id:req.enrollmentID});
			protoReq.setRole(rolesToMask(req.roles));
			protoReq.setAffiliation(req.affiliation);

			// Create registrar info
			var protoRegistrar = new _caProto.Registrar();
			protoRegistrar.setId({id:registrar.getName()});
			if (req.registrar) {
				if (req.registrar.roles) {
					protoRegistrar.setRoles(req.registrar.roles);
				}
				if (req.registrar.delegateRoles) {
					protoRegistrar.setDelegateRoles(req.registrar.delegateRoles);
				}
			}

			protoReq.setRegistrar(protoRegistrar);

			// Sign the registration request
			var buf = protoReq.toBuffer();
			var signKey = self.cryptoPrimitives.getKeyPairForSigning(registrar.getEnrollment().key, 'hex');
			var sig = self.cryptoPrimitives.sign(signKey, buf);
			protoReq.setSig( new _caProto.Signature(
				{
					type: _caProto.CryptoType[self.cryptoPrimitives.getPublicKeyAlgorithm()],
					r: new Buffer(sig.r.toString()),
					s: new Buffer(sig.s.toString())
				}
			));

			// Send the registration request
			self._ecaaClient.registerUser(protoReq, function (err, token) {
				if (err) {
					reject(err);
				} else {
					return resolve(token ? token.tok.toString() : null);
				}
			});
		});
	}

	/**
	 * Enroll the member and return an opaque member object
	 * @param req Enrollment request with the following fields: name, enrollmentSecret
	 * @returns Promise for [Enrollment]{@link module:api.Enrollment}
	 * @ignore
	 */
	enroll(req) {
		var self = this;

		return new Promise(function(resolve, reject) {
			if (!req.enrollmentID) {
				reject(new Error('req.enrollmentID is not set'));
				return;
			}

			if (!req.enrollmentSecret) {
				reject(new Error('req.enrollmentSecret is not set'));
				return;
			}

			// generate key pairs for signing and encryption
			// 1) signing key
			var signingKeyPair = self.cryptoPrimitives.generateKeyPair();
			var spki = new asn1.x509.SubjectPublicKeyInfo(signingKeyPair.pubKeyObj);
			// 2) encryption key
			var encryptionKeyPair = self.cryptoPrimitives.generateKeyPair();
			var spki2 = new asn1.x509.SubjectPublicKeyInfo(encryptionKeyPair.pubKeyObj);

			// create the proto message
			var eCertCreateRequest = new _caProto.ECertCreateReq();
			var timestamp = utils.generateTimestamp();
			eCertCreateRequest.setTs(timestamp);
			eCertCreateRequest.setId({id: req.enrollmentID});
			eCertCreateRequest.setTok({tok: new Buffer(req.enrollmentSecret)});

			// public signing key (ecdsa)
			var signPubKey = new _caProto.PublicKey(
				{
					type: _caProto.CryptoType[self.cryptoPrimitives.getPublicKeyAlgorithm()],
					key: new Buffer(spki.getASN1Object().getEncodedHex(), 'hex')
				});
			eCertCreateRequest.setSign(signPubKey);

			// public encryption key (ecdsa)
			var encPubKey = new _caProto.PublicKey(
				{
					type: _caProto.CryptoType[self.cryptoPrimitives.getPublicKeyAlgorithm()],
					key: new Buffer(spki2.getASN1Object().getEncodedHex(), 'hex')
				});
			eCertCreateRequest.setEnc(encPubKey);

			self._ecapClient.createCertificatePair(eCertCreateRequest, function (err, eCertCreateResp) {
				if (err) {
					reject(err);
					return;
				}

				var cipherText = eCertCreateResp.tok.tok;
				var decryptedTokBytes = self.cryptoPrimitives.asymmetricDecrypt(encryptionKeyPair.prvKeyObj, cipherText);

				//debug(decryptedTokBytes);
				// debug(decryptedTokBytes.toString());
				// debug('decryptedTokBytes [%s]', decryptedTokBytes.toString());
				eCertCreateRequest.setTok({tok: decryptedTokBytes});
				eCertCreateRequest.setSig(null);

				var buf = eCertCreateRequest.toBuffer();

				var signKey = self.cryptoPrimitives.getKeyPairForSigning(signingKeyPair.prvKeyObj.prvKeyHex, 'hex');
				//debug(new Buffer(sha3_384(buf),'hex'));
				var sig = self.cryptoPrimitives.sign(signKey, buf);

				eCertCreateRequest.setSig(new _caProto.Signature(
					{
						type: _caProto.CryptoType[self.cryptoPrimitives.getPublicKeyAlgorithm()],
						r: new Buffer(sig.r.toString()),
						s: new Buffer(sig.s.toString())
					}
				));
				self._ecapClient.createCertificatePair(eCertCreateRequest, function (err, eCertCreateResp) {
					if (err) {
						reject(err);
						return;
					}

					var enrollment = {
						key: signingKeyPair.prvKeyObj.prvKeyHex,
						cert: eCertCreateResp.certs.sign.toString('hex'),
						chainKey: eCertCreateResp.pkchain.toString('hex')
					};
					// debug('cert:\n\n',enrollment.cert)
					return resolve(enrollment);
				});
			});
		});
	}
};

// Convert a list of member type names to the role mask currently used by the peer
function rolesToMask(roles /*string[]*/) {
	var mask = 0;

	if (roles) {
		for (var role in roles) {
			switch (roles[role]) {
			case 'client':
				mask |= 1;
				break;       // Client mask
			case 'peer':
				mask |= 2;
				break;       // Peer mask
			case 'validator':
				mask |= 4;
				break;  // Validator mask
			case 'auditor':
				mask |= 8;
				break;    // Auditor mask
			}
		}
	}
	if (mask === 0)
		mask = 1;  // Client

	return mask;
}

module.exports = MemberServices;

