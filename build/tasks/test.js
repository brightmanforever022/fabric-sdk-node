'use strict';

var gulp = require('gulp');
var tape = require('gulp-tape');
var tapColorize = require('tap-colorize');
var istanbul = require('gulp-istanbul');

gulp.task('pre-test', function() {
	return gulp.src([
		'node_modules/fabric-client/lib/**/*.js',
		'node_modules/fabric-ca-client/lib/FabricCAClientImpl.js'])
	.pipe(istanbul())
	.pipe(istanbul.hookRequire());
});

gulp.task('test', ['lint', 'test-headless'], function() {
	// use individual tests to control the sequence they get executed
	// first run the ca-tests that tests all the member registration
	// and enrollment scenarios (good and bad calls). Then the rest
	// of the tests will re-use the same key value store that has
	// saved the user certificates so they can interact with the
	// network
	return gulp.src([
		// 'test/integration/ca-tests.js',
		'test/integration/chain-fabriccop-tests.js',
		'test/integration/endorser-tests.js',
		'test/integration/orderer-chain-tests.js',
		'test/integration/install.js'
	])
	.pipe(tape({
		reporter: tapColorize()
	}))
	.pipe(istanbul.writeReports());
});

gulp.task('test-headless', ['lint', 'pre-test'], function() {
	// this is needed to avoid a problem in tape-promise with adding
	// too many listeners
	// to the "unhandledRejection" event
	process.setMaxListeners(0);

	return gulp.src([
		'test/unit/**/*.js',
		'!test/unit/util.js',
		'!test/unit/pkcs11.js'
	])
	.pipe(tape({
		reporter: tapColorize()
	}))
	.pipe(istanbul.writeReports({
		reporters: ['lcov', 'json', 'text',
			'text-summary', 'cobertura']
	}));
});
