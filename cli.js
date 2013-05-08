#!/usr/bin/env node
/*
 * Copyright 2013 Lloyd Smith II
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */ 
var esprima = require('esprima'),
    fs = require('fs'),
    path = require('path'),
    winston = require('winston'),
    unmodulizer = require('./unmodulizer'),
    optimist = require('optimist');

var variableNamers = unmodulizer.variableNamers;

winston.cli();

var argv = optimist.usage('Unmodulize AMD dependencies so that you don\'t need a module loader (like RequireJS or Almond) to execute the script.\nUsage: $0 -f [file]')
  .demand('f')
  .alias('f', 'file')
  .string('f')
  .describe('f', 'The file to "unmodulize"')
  .string('o')
  .alias('o','output')
  .describe('o', 'An output file. If not specified, then the unmofulized code is printed to standard out.')
  .boolean('overwrite')
  .describe('overwrite', 'Overwrite the output file, if it exists. By default existing files are not overwritten.')
  .string('n')
  .alias('n', 'namer')
  .describe('n', 'The variable namer to use: one of ' + Object.keys(variableNamers).sort().join(', '))
  .default('n', 'default')
  .string('stub')
  .describe('stub', 'A module to stub, e.g., --stub "jquery:lib/jquery" --stub-jquery "return window.jQuery;"')
  .argv;

var filename = path.normalize(path.join(process.cwd(), argv.f));
try {

  var code = fs.readFileSync(filename, 'utf-8'),
      moduleStubs;

  if(!variableNamers[argv.n]) {
    winston.error('Invalid variable namer! ' + argv.n);
    optimist.showHelp();
    process.exit(1);
  }

  if(argv.stub) {
    moduleStubs = (argv.stub instanceof Array ? argv.stub : [argv.stub]).map(function(value) {
      // parse out arguments for stub:
      // --stub "{key}:{moduleId}"
      // --stub-{key} "{expressionSource}"
      var sep = value.indexOf(':'),
          key = value.substring(0, sep),
          moduleId = value.substring(sep+1),
          expressionSource = argv['stub-'+key],
          stubSyntax = unmodulizer.makeModuleStub(moduleId, [], expressionSource);

        return {
          syntax: stubSyntax,
          moduleId: moduleId,
          deps: [] // deps are not supported yet
        };
    });
  }


  var result = unmodulizer.unmodulize(code, variableNamers[argv.n], moduleStubs)+'\n';
  if(argv.o) {
    var outputFile = path.normalize(path.join(process.cwd(), argv.o)),
        flag = 'wx+'; // write to a newly-created file only (no overwriting)

    if(argv.overwrite) {
      flag = 'w';
    }

    try {
      fs.writeFileSync(outputFile, result, {
        flag: flag 
      });
      winston.info('unmodulized code written to: ' + outputFile);
    } catch(writeErr) {
      if(writeErr.code === 'EEXIST') {
        winston.error('Not overwriting existing output file: ' + outputFile);
        process.exit(1);
      } else {
        throw writeErr;
      }
    }
  } else {
    process.stdout.write(result);
  }
} catch(err) {
  winston.error('erasing AMD module defines from source at: [' + filename + ']');
  winston.error('AST transformation failed with error:' + err, err);
  console.dir(err);
  throw err;
}

