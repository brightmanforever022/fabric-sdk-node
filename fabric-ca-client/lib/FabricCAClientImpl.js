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

var api = require('./api.js');
var utils = require('./utils.js');
var util = require('util');
var jsrsa = require('jsrsasign');
var asn1 = jsrsa.asn1;
var path = require('path');
var http = require('http');
var https = require('https');
var urlParser = require('url');


var logger = utils.getLogger('FabricCAClientImpl.js');

/**
 * This is an implementation of the member service client which communicates with the Fabric CA server.
 * @class
 */
var FabricCAServices = class {

	/**
	 * constructor
	 *
	 * @param {string} url The endpoint URL for Fabric CA services of the form: "http://host:port" or "https://host:port"
	 * @param {object} cryptoSetting This optional parameter is an object with the following optional properties:
	 * - software {boolean}: Whether to load a software-based implementation (true) or HSM implementation (false)
	 *	default is true (for software based implementation), specific implementation module is specified
	 *	in the setting 'crypto-suite-software'
	 * - keysize {number}: The key size to use for the crypto suite instance. default is value of the setting 'crypto-keysize'
	 * - algorithm {string}: Digital signature algorithm, currently supporting ECDSA only with value "EC"
	 *
	 * @param {string} KVSImplClass Optional. The built-in key store saves private keys. The key store may be backed by different
	 * {@link KeyValueStore} implementations. If specified, the value of the argument must point to a module implementing the
	 * KeyValueStore interface.
	 * @param {object} opts Implementation-specific options object for the {@link KeyValueStore} class to instantiate an instance
	 */
	constructor(url, cryptoSettings, KVSImplClass, opts) {

		var endpoint = FabricCAServices._parseURL(url);

		this._fabricCAClient = new FabricCAClient({
			protocol: endpoint.protocol,
			hostname: endpoint.hostname,
			port: endpoint.port
		});

		this.cryptoPrimitives = utils.getCryptoSuite(cryptoSettings, KVSImplClass, opts);

		logger.info('Successfully constructed Fabric CA service client: endpoint - %j', endpoint);

	}

	getCrypto() {
		return this.cryptoPrimitives;
	}

	/**
	 * Register the member and return an enrollment secret.
	 * @param {Object} req Registration request with the following fields:
	 * <br> - enrollmentID {string}. ID which will be used for enrollment
	 * <br> - group {string}. Group to which this user will be assigned, like a company or an organization
	 * <br> - attrs {{@link KeyValueAttribute}[]}. Array of key/value attributes to assign to the user.
	 * @param registrar {User}. The identity of the registrar (i.e. who is performing the registration)
	 * @returns {Promise} The enrollment secret to use when this user enrolls
	 */
	register(req, registrar) {
		if (typeof req === 'undefined' || req === null) {
			throw new Error('Missing required argument "request"');
		}

		if (typeof req.enrollmentID === 'undefined' || req.enrollmentID === null) {
			throw new Error('Missing required argument "request.enrollmentID"');
		}

		if (typeof registrar === 'undefined' || registrar === null) {
			throw new Error('Missing required argument "registrar"');
		}

		if (typeof registrar.getName !== 'function') {
			throw new Error('Argument "registrar" must be an instance of the class "User", but is found to be missing a method "getName()"');
		}

		if (typeof registrar.getSigningIdentity !== 'function') {
			throw new Error('Argument "registrar" must be an instance of the class "User", but is found to be missing a method "getSigningIdentity()"');
		}

		return this._fabricCAClient.register(req.enrollmentID, 'client', req.group, req.attrs, registrar.getName(), registrar.getSigningIdentity());
	}

	/**
	 * Enroll the member and return an opaque member object.
	 * @param req Enrollment request
	 * @param {string} req.enrollmentID The registered ID to use for enrollment
	 * @param {string} req.enrollmentSecret The secret associated with the enrollment ID
	 * @returns Promise for an object with "key" for private key and "certificate" for the signed certificate
	 */
	enroll(req) {
		var self = this;

		return new Promise(function (resolve, reject) {
			if (!req.enrollmentID) {
				logger.error('Invalid enroll request, missing enrollmentID');
				return reject(new Error('req.enrollmentID is not set'));
			}

			if (!req.enrollmentSecret) {
				logger.error('Invalid enroll request, missing enrollmentSecret');
				return reject(new Error('req.enrollmentSecret is not set'));
			}

			var enrollmentID = req.enrollmentID;
			var enrollmentSecret = req.enrollmentSecret;

			//generate enrollment certificate pair for signing
			self.cryptoPrimitives.generateKey()
				.then(
				function (privateKey) {
					//generate CSR using enrollmentID for the subject
					try {
						var csr = privateKey.generateCSR('CN=' + req.enrollmentID);
						self._fabricCAClient.enroll(req.enrollmentID, req.enrollmentSecret, csr)
							.then(
							function (csrPEM) {
								return resolve({
									key: privateKey,
									certificate: csrPEM
								});
							},
							function (err) {
								return reject(err);
							}
							);

					} catch (err) {
						return reject(new Error(util.format('Failed to generate CSR for enrollmemnt due to error [%s]', err)));
					}
				},
				function (err) {
					return reject(new Error(util.format('Failed to generate key for enrollment due to error [%s]', err)));
				}
				);

		});
	}

	/**
	 * @typedef {Object} FabricCAServices-HTTPEndpoint
	 * @property {string} hostname
	 * @property {number} port
	 * @property {string} protocol
	 */

	/**
	 * Utility function which parses an HTTP URL into its component parts
	 * @param {string} url HTTP or HTTPS url including protocol, host and port
	 * @returns {...FabricCAServices-HTTPEndpoint}
	 * @throws InvalidURL for malformed URLs
	 * @ignore
	 */
	static _parseURL(url) {

		var endpoint = {};

		var purl = urlParser.parse(url, true);

		if (purl.protocol && purl.protocol.startsWith('http')) {
			if (purl.protocol.slice(0, -1) != 'https') {
				if (purl.protocol.slice(0, -1) != 'http') {
					throw new Error('InvalidURL: url must start with http or https.');
				}
			}
			endpoint.protocol = purl.protocol.slice(0, -1);
			if (purl.hostname) {
				endpoint.hostname = purl.hostname;

				if (purl.port) {
					endpoint.port = parseInt(purl.port);
				}

			} else {
				throw new Error('InvalidURL: missing hostname.');
			}

		} else {
			throw new Error('InvalidURL: url must start with http or https.');
		}

		return endpoint;
	}

	/**
	* return a printable representation of this object
	*/
	toString() {
		return ' FabricCAServices : {' +
			'hostname: ' + this._fabricCAClient._hostname +
			', port: ' + this._fabricCAClient._port +
			'}';
	}
};

/**
 * Client for communciating with the Fabric CA APIs
 *
 * @class
 */
var FabricCAClient = class {

	/**
	 * @typedef {Object} FabricCAServices-HTTPEndpoint
	 * @property {string} hostname
	 * @property {number} port
	 * @property {boolean} isSecure
	 */

	/**
	 * constructor
	 *
	 * @param {object} connect_opts Connection options for communciating with the Fabric CA server
	 * @param {string} connect_opts.protocol The protocol to use (either HTTP or HTTPS)
	 * @param {string} connect_opts.hostname The hostname of the Fabric CA server endpoint
	 * @param {number} connect_opts.port The port of the Fabric CA server endpoint
	 * @throws Will throw an error if connection options are missing or invalid
	 *
	 */
	constructor(connect_opts) {

		//check connect_opts
		try {
			this._validateConnectionOpts(connect_opts);
		} catch (err) {
			throw new Error('Invalid connection options.  ' + err.message);
		}


		this._httpClient = (connect_opts.protocol = 'http') ? http : https;
		this._hostname = connect_opts.hostname;
		if (connect_opts.port) {
			this._port = connect_opts.port;
		} else {
			this._port = (connect_opts.protocol === 'http' ? 80 : 443);
		}
		this._baseAPI = '/api/v1/cfssl/';


	}

	/**
	 * @typedef {Object} KeyValueAttribute
	 * @property {string} key The key used to reference the attribute
	 * @property {string} value The value of the attribute
	 */

	/**
	 * Register a new user and return the enrollment secret
	 * @param {string} enrollmentID ID which will be used for enrollment
	 * @param {string} role Type of role for this user
	 * @param {string} group Group to which this user will be assigned
	 * @param {KeyValueAttribute[]} attrs Array of key/value attributes to assign to the user
	 * @param {string} callerID The ID of the user who is registering this user
	 * @param {SigningIdentity} signingIdentity The instance of a SigningIdentity encapsulating the
	 * signing certificate, hash algorithm and signature algorithm
	 * @returns {Promise} The enrollment secret to use when this user enrolls
	 */
	register(enrollmentID, role, group, attrs, callerID, signingIdentity) {

		var self = this;
		var numArgs = arguments.length;

		return new Promise(function (resolve, reject) {
			//all arguments are required
			if (numArgs < 6) {
				reject(new Error('Missing required parameters.  \'enrollmentID\', \'role\', \'group\', \'attrs\', \
					\'callerID\' and \'signingIdentity\' are all required.'));
			}


			var regRequest = {
				'id': enrollmentID,
				'type': role,
				'group': group,
				'attrs': attrs,
				'callerID': callerID
			};

			var requestOptions = {
				hostname: self._hostname,
				port: self._port,
				path: self._baseAPI + 'register',
				method: 'POST',
				headers: {
					Authorization: FabricCAClient.generateAuthToken(regRequest, signingIdentity)
				}
			};

			var request = self._httpClient.request(requestOptions, function (response) {

				const responseBody = [];
				response.on('data', function (chunk) {
					responseBody.push(chunk);
				});

				response.on('end', function () {

					var payload = responseBody.join('');

					if (!payload) {
						reject(new Error(
							util.format('Registerfailed with HTTP status code ', response.statusCode)));
					}
					//response should be JSON
					try {
						var regResponse = JSON.parse(payload);
						if (regResponse.success) {
							// we want the result field which is Base64-encoded secret.
							// TODO: Keith said this may be changed soon for 'result' to be the raw secret
							// without Base64-encoding it
							return resolve(Buffer.from(regResponse.result, 'base64').toString());
						} else {
							return reject(new Error(
								util.format('Register failed with errors [%s]', JSON.stringify(regResponse.errors))));
						}

					} catch (err) {
						reject(new Error(
							util.format('Could not parse register response [%s] as JSON due to error [%s]', payload, err)));
					}
				});

			});

			request.on('error', function (err) {
				reject(new Error(util.format('Calling register endpoint failed with error [%s]', err)));
			});

			request.write(JSON.stringify(regRequest));
			request.end();
		});
	}

	/**
	 * Generate authorization token required for accessing fabric-ca APIs
	 */
	static generateAuthToken(reqBody, signingIdentity) {
		// sometimes base64 encoding results in trailing one or two "=" as padding
		var trim = function(string) {
			return string.replace(/=*$/, '');
		};

		// specific signing procedure is according to:
		// https://github.com/hyperledger/fabric-ca/blob/master/util/util.go#L213
		var cert = trim(Buffer.from(signingIdentity._certificate).toString('base64'));
		var body = trim(Buffer.from(JSON.stringify(reqBody)).toString('base64'));

		var bodyAndcert = body + '.' + cert;
		var sig = signingIdentity.sign(bodyAndcert);

		var b64Sign = trim(Buffer.from(sig, 'hex').toString('base64'));
		return cert + '.' + b64Sign;
	}

	/**
	 * Enroll a registered user in order to receive a signed X509 certificate
	 * @param {string} enrollmentID The registered ID to use for enrollment
	 * @param {string} enrollmentSecret The secret associated with the enrollment ID
	 * @param {string} csr PEM-encoded PKCS#10 certificate signing request
	 * @returns {Promise} PEM-encoded X509 certificate
	 * @throws Will throw an error if all parameters are not provided
	 * @throws Will throw an error if calling the enroll API fails for any reason
	 */
	enroll(enrollmentID, enrollmentSecret, csr) {

		var self = this;
		var numArgs = arguments.length;

		return new Promise(function (resolve, reject) {
			//check for required args
			if (numArgs < 3) {
				return reject(new Error('Missing required parameters.  \'enrollmentID\', \'enrollmentSecret\' and \'csr\' are all required.'));
			}

			var requestOptions = {
				hostname: self._hostname,
				port: self._port,
				path: self._baseAPI + 'enroll',
				method: 'POST',
				auth: enrollmentID + ':' + enrollmentSecret
			};

			var enrollRequest = {
				certificate_request: csr
			};

			var request = self._httpClient.request(requestOptions, function (response) {

				const responseBody = [];
				response.on('data', function (chunk) {
					responseBody.push(chunk);
				});

				response.on('end', function () {

					var payload = responseBody.join('');

					if (!payload) {
						reject(new Error(
							util.format('Enrollment failed with HTTP status code ', response.statusCode)));
					}
					//response should be JSON
					try {
						var enrollResponse = JSON.parse(payload);
						if (enrollResponse.success) {
							//we want the result field which is Base64-encoded PEM
							return resolve(new Buffer.from(enrollResponse.result, 'base64').toString());
						} else {
							return reject(new Error(
								util.format('Enrollment failed with errors [%s]', JSON.stringify(enrollResponse.errors))));
						}

					} catch (err) {
						reject(new Error(
							util.format('Could not parse enrollment response [%s] as JSON due to error [%s]', payload, err)));
					}
				});

			});

			request.on('error', function (err) {
				reject(new Error(util.format('Calling enrollment endpoint failed with error [%s]', err)));
			});

			request.write(JSON.stringify(enrollRequest));
			request.end();

		});

	}

	/**
	 * Convert a PEM encoded certificate to DER format
	 * @param {string) pem PEM encoded public or private key
	 * @returns {string} hex Hex-encoded DER bytes
	 * @throws Will throw an error if the conversation fails
	 */
	static pemToDER(pem) {

		//PEM format is essentially a nicely formatted base64 representation of DER encoding
		//So we need to strip "BEGIN" / "END" header/footer and string line breaks
		//Then we simply base64 decode it and convert to hex string
		var contents = pem.toString().trim().split(/\r?\n/);
		//check for BEGIN and END tags
		if (!(contents[0].match(/\-\-\-\-\-\s*BEGIN ?([^-]+)?\-\-\-\-\-/) &&
			contents[contents.length - 1].match(/\-\-\-\-\-\s*END ?([^-]+)?\-\-\-\-\-/))) {
			throw new Error('Input parameter does not appear to be PEM-encoded.');
		};
		contents.shift(); //remove BEGIN
		contents.pop(); //remove END
		//base64 decode and encode as hex string
		var hex = Buffer.from(contents.join(''), 'base64').toString('hex');
		return hex;
	}

	/**
	 * Validate the connection options
	 * @throws Will throw an error if any of the required connection options are missing or invalid
	 * @ignore
	 */
	_validateConnectionOpts(connect_opts) {
		//check for protocol
		if (!connect_opts.protocol) {
			throw new Error('Protocol must be set to \'http\' or \'https\'');
		};

		if (connect_opts.protocol != 'http') {
			if (connect_opts.protocol != 'https') {
				throw new Error('Protocol must be set to \'http\' or \'https\'');
			}
		};

		if (!connect_opts.hostname) {
			throw new Error('Hostname must be set');
		};

		if (connect_opts.port) {
			if (!Number.isInteger(connect_opts.port)) {
				throw new Error('Port must be an integer');
			}
		}

	}
};

module.exports = FabricCAServices;
module.exports.FabricCAClient = FabricCAClient;
