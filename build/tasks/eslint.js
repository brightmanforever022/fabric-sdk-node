var gulp = require('gulp');
var eslint = require('gulp-eslint');

gulp.task('lint', function () {
	return gulp.src(['**/*.js', 'hfc/**/*.js', '!node_modules/**', '!docs/**', '!coverage/**', '!tmp/**', 'hfc-cop/lib/*.js'])
		.pipe(eslint(
			{
				env: ['es6', 'node'],
				extends: 'eslint:recommended',
				parserOptions: {
					sourceType: 'module'
				},
				rules: {
					indent: ['error', 'tab'],
					'linebreak-style': ['error', 'unix'],
					quotes: ['error', 'single'],
					semi: ['error', 'always'],
					'no-trailing-spaces': ['error'],
					'max-len': [
						'error',
						{
							'code': 150,
							'ignoreTrailingComments': true,
							'ignoreUrls': true,
							'ignoreStrings': true,
							'ignoreTemplateLiterals': true,
							'ignoreRegExpLiterals': true
						}
					]
				}
			}
		))
		.pipe(eslint.format())
		.pipe(eslint.failAfterError());
});
