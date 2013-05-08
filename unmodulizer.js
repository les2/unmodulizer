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
var escodegen = require('escodegen'),
    esprima = require('esprima'),
    path = require('path');

var variableNamers = {
  'default': defaultVariableNamer,
  globals: globalsVariableNamer,
  namespace: namespaceVariableNamer
};

module.exports = {
  unmodulize: unmodulize,
  variableNamers: variableNamers,
  makeModuleStub: makeModuleStub
};

function unmodulize(code, variableNamer, stubs) {

  var syntax = esprima.parse(code, {
    loc: true,
    range: true,
    raw: true,
    tokens: true,
    comment: true,
    tolerant: false
  });

  // insert all the stubs first in the program body:
  Array.prototype.unshift.apply(syntax.body, (stubs || []).map(function(stub) { return stub.syntax; }));

  var outputAst = {
        type: 'Program',
        body: []
      },
      moduleIdToVarNameMap = {},
      varNameToModuleIdMap = {},
      count = 0;

  syntax.body.forEach(function(node) {

    var parsedNode, replacement;

    if((parsedNode = parseDefineCall(node))) {
      replacement = getTransformedDefineCall();
    } else if((parsedNode = parseRequireCall(node))) {
      replacement = getTransformedRequireCall();
    } else if((parsedNode = parseRequireCallWithNoCallback(node))) {

      // make sure all dependencies are known!
      parsedNode.deps.forEach(function(moduleId) {
        if(!isModuleDefined(moduleId)) {
          throw new Error('module "' + moduleId +
            '" in require invocation without callback is not defined! '
            + debugJSON(node.loc));
        }
      });

      replacement = {
        type: 'EmptyStatement' // TODO: omit this entirely
      };
    }

    outputAst.body.push(replacement || node);

    function getTransformedDefineCall() {

      var varName = registerNewVarNameForModule(parsedNode.moduleId);

      // replace:
      //
      //      define(moduleId, [dep1, dep2, ...], function(one, two, ...) { })
      //
      // with:
      //
      //      var moduleId = (function(one, two, ...){})(dep1, dep2, ...);
      return {
        type: 'VariableDeclaration',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: {
              type: 'Identifier',
              name: varName
            },
            init: {
              type: 'CallExpression',
              callee: parsedNode.factory,
              'arguments': parsedNode.deps.map(function(depId) {
                var depVarName = moduleIdToVarNameMap[depId];
                if(!depVarName) {
                  throw new Error('No previous define for dependency "' +
                    depId + '" used in factory for module "' +
                    parsedNode.moduleId + '": location: ' +
                    debugJSON(node.loc));
                }
                return {
                  type: 'Identifier',
                  name: moduleIdToVarNameMap[depId]
                };
              })
            }
          }
        ],
        kind: 'var'
      };
    }

    function getTransformedRequireCall() {

      var requireArgs = parsedNode.deps.map(function(depId) {
        if(!moduleIdToVarNameMap[depId]) {
          throw new Error('require has unknown dependency "' + depId +
            '" : ' + debugJSON(node.loc) + '\nIdentifier map: ' + debugJSON(moduleIdToVarNameMap));
        }
        return {
          type: 'Identifier',
          name: moduleIdToVarNameMap[depId]
        };
      });

      // replace:
      //
      //      require([dep1, dep1, ...], function(one, two, ...) {} )
      //
      // with:
      //
      //      (function(one, two, ...){})(dep1, dep2, ...);
      return {
        type: 'ExpressionStatement',
          expression: {
            type: 'CallExpression',
            callee: parsedNode.callback,
            'arguments': requireArgs
          }
      };
    }
  });

  return escodegen.generate(outputAst);

  function isModuleDefined(moduleId) {
    // TODO: what if sb uses 'toString' for a module id?
    return moduleIdToVarNameMap.hasOwnProperty(moduleId);
  }

  function isVarNameTaken(varName) {
    return varNameToModuleIdMap.hasOwnProperty(varName);
  }

  function registerNewVarNameForModule(moduleId) {

    var varName;

    if(isModuleDefined(moduleId)) {
      throw new Error('module already defined: ' +
          moduleId + ' ' + debugJSON(node.loc));
    }

    // TODO: check that varName is a valid identifier, etc.

    varName = variableNamer(moduleId, count);
    if(isVarNameTaken(varName)) {
      throw new Error('variableNamer function produced a non-unique variable name for module: [' +
          moduleId + '] , count: ' + count + ' : given varName: ' +
          varName + 'varNameToModuleIdMap => ' +
          debugJSON(varNameToModuleIdMap));
    }
    count++;
    moduleIdToVarNameMap[moduleId] = varName;
    varNameToModuleIdMap[varName] = moduleId;

    return varName;
  }
}

// variable namer intended for situations where you are wrapping in a closure
// and minifying the code so that the variable names will be changed anyway.
function defaultVariableNamer(moduleId, count) {
  return '____$unmodulizer$'+count+'$'+sanitizeVarName(moduleId);
}

function sanitizeVarName(varName) {
  varName = varName.replace(/[^a-zA-Z0-9_\$]/g,'')
    .replace(/^([^a-zA-Z])/,function(match, ch) {
      return '$'+ch.replace(/[^a-zA-Z0-9\$_]/,'');
    });
  if(varName === '') {
    varName = '$';
  }
  return varName;
}

// turn a module name like: foo/bar/car => FooBarCar
function globalsVariableNamer(moduleId) {
  var name = moduleId.replace(/\/([a-z])/g, function(match, ch) {
    return ch.toUpperCase();
  })
  .replace(/^([a-z])/, function(match, ch) {
    return ch.toUpperCase();
  })
  .replace(/[^a-zA-Z0-9_\$]/g, '');

  return name;
}

function namespaceVariableNamer(moduleId) {
  // TODO - do AST transform to create namespace as we go (if not there)
  return moduleId.replace(/\//g, '.');
}

function parseDefineCall(node) {

  var result;
  if(isFuncCall(node, 'define')) {
      var expr = node.expression;
      var args = expr['arguments'];
      if(args.length === 3 &&
          args[0].type === 'Literal' &&
          args[1].type === 'ArrayExpression' &&
          args[2].type === 'FunctionExpression') {

          var moduleId = args[0].value;
          result = {
              moduleId: moduleId,
              deps: parseDepsArg(args[1], function(depId) {
                if(depId[0] === '.') {
                  return path.resolve('/'+moduleId.substring(0, moduleId.lastIndexOf('/')), depId).substring(1);
                  // TODO: hack to handle relative paths
                } else {
                  return depId;
                }
              }),
              factory: args[2]
          };
      }
  }

  return result;
}

function parseRequireCall(node) {

  var result;

  if(isFuncCall(node, 'require')) {
      var expr = node.expression,
          args = expr['arguments'];
      if(args.length === 2 &&
          args[0].type === 'ArrayExpression' &&
          args[1].type === 'FunctionExpression') {

          result = {
              deps: parseDepsArg(args[0]),
              callback: args[1]
          };
      }
  }

  return result;
}

/**
 * Gets an array of module ids from the ArrayExpression of a 'define'
 * or 'require' call. The factory can be used to further
 * process the module id (e.g., resolve relative module paths).
 *
 * @param arg {ArrayExpression}
 * @param factory? {function}
 * @return {Array} of {string} dependency ids
 */
function parseDepsArg(arg, factory) {
  return arg.elements.map(function(depEl) {
    // TODO: assert a {string} literal
    if(typeof factory === "function") {
      return factory(depEl.value, depEl);
    }
    return depEl.value;
  });
}

// parse a require invocation that does not have a callback:
//
//    require(['dep1', 'dep2', ...]);
// 
// the purpose of such a require call can only be for the side effects,
// of the modules having loaded; in practice, these side effects are only
// useful for "main" modules (the main entry-point to an application);
//
// most modules simply return constructors, functions, or namespaces and
// do minimal work upon initialization (never do work in constructors, right).
//
// so ... when we encounter these, we need to delete them! why?
// the corresponding defines for the dependencies will already have been erased
// and therefore had its factory invoked.
//
// Put another, a missing callback is the same as a no-op callback:
//
//    require(['dep1'], function() {
//    });
//
//      =>
//    (function() {})(dep1); // <---- pointless
function parseRequireCallWithNoCallback(node) {
  var expr, result;
  if(isFuncCall(node, 'require')) {
    var expr = node.expression,
        args = expr['arguments'];
    if(args.length === 1 &&
        args[0].type === 'ArrayExpression') {
        result = {
          deps : parseDepsArg(args[0]),
          skip: true
        };
    }
  }
  return result;
}

function isFuncCall(node, name) {
  var expr;
  if(node.type === "ExpressionStatement" && (expr = node.expression) &&
      expr.type === "CallExpression" &&
      expr.callee.type === "Identifier" &&
      expr.callee.name === name) {
          return true;
  }
  return false;
}

function makeModuleStub(moduleId, deps, expressionSource) {
  // TODO: allow dependencies
  var expr = esprima.parse(expressionSource);
  if(!(expr.body.length === 1 && expr.body[0].type === 'ExpressionStatement')) {
    throw new Error('ExpressionStatement required for stubbed module "' +
        moduleId + '" : source => "' + expressionSource + '" parsed to ' + debugJSON(expr));
  }
  return {
        "type": "ExpressionStatement",
        "expression": {
            "type": "CallExpression",
            "callee": {
                "type": "Identifier",
                "name": "define"
            },
            "arguments": [
                {
                    "type": "Literal",
                    "value": moduleId
                },
                {
                    "type": "ArrayExpression",
                    "elements": []
                },
                {
                    "type": "FunctionExpression",
                    "id": null,
                    "params": [],
                    "defaults": [],
                    "body": {
                        "type": "BlockStatement",
                        "body": [
                            {
                                "type": "ReturnStatement",
                                "argument": expr.body[0].expression
                            }
                        ]
                    },
                    "rest": null,
                    "generator": false,
                    "expression": false
                }
            ]
        }
    };
}

function debugJSON(obj) {
  return JSON.stringify(obj, null, 2);
}

