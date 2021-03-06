/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { codemodel, processCodeModel, Schema, allVirtualParameters, allVirtualProperties } from '@microsoft.azure/autorest.codemodel-v3';
import { Host, Channel } from '@microsoft.azure/autorest-extension-base';
import { values, pascalCase, fixLeadingNumber, deconstruct, where } from '@microsoft.azure/codegen';
import { CommandOperation } from '@microsoft.azure/autorest.codemodel-v3/dist/code-model/command-operation';


let directives: Array<any> = [];

interface WhereCommandDirective {
  where: {
    noun?: string;
    verb?: string;
    variant?: string;
    'parameter-name'?: string;
  };
  set: {
    noun?: string;
    verb?: string;
    variant?: string;
    hidden?: Boolean;
    'parameter-name'?: string;
    'parameter-description'?: string;
  };
}

interface WhereModelDirective {
  where: {
    'model-name'?: string;
    'property-name'?: string;
  };
  set: {
    'model-name'?: string;
    'property-name'?: string;
    'property-description'?: string;
  };
}

function isWhereCommandDirective(it: any): it is WhereCommandDirective {
  const directive = it;
  const where = directive.where;
  const set = directive.set;
  if (where && set) {
    if ((set['parameter-name'] || set.hidden || set.noun || set["parameter-description"] || set.verb || set.variant)
      && (where.noun || where.verb || where.variant || where["parameter-name"])) {
      let error = where['model-name'] ? `Can't select model and command at the same time.` : ``;
      error += where['property-name'] ? `Can't select property and command at the same time.` : ``;
      error += set['property-name'] ? `Can't set a property-name when a command is selected.` : ``;
      error += set['property-description'] ? `Can't set a property-description when a command is selected.` : ``;
      error += set['model-name'] ? `Can't set a model-name when a command is selected.` : ``;
      if (error) {
        throw Error(`Incorrect Directive: ${JSON.stringify(it, null, 2)}. Reason: ${error}.`);
      }

      return true;
    }
  }

  return false;
}


function isWhereModelDirective(it: any): it is WhereModelDirective {
  const directive = it;
  const where = directive.where;
  const set = directive.set;
  if (where && set) {
    if ((set["model-name"] || set["property-description"] || set["property-name"])
      && (where['model-name'] || where['property-name'])) {
      let error = where['noun'] || where['verb'] || where['variant'] ? `Can't select model and command at the same time.` : ``;
      error += where['parameter-name'] ? `Can't select a parameter and command at the same time.` : ``;
      error += set['property-name'] ? `Can't set property-name when a model is selected.` : ``;
      error += set['noun'] ? `Can't set command noun when a model is selected.` : ``;
      error += set['verb'] ? `Can't set command verb when a model is selected.` : ``;
      error += set['variant'] ? `Can't set command variant when a model is selected.` : ``;
      error += set['hidden'] ? `Can't hide a command when a model is selected.` : ``;
      error += set['variant'] ? `Can't set a variant name when a model is selected.` : ``;
      if (error) {
        throw Error(`Incorrect Directive: ${JSON.stringify(it, null, 2)}.Reason: ${error}.`);
      }

      return true;
    }
  }


  return false;
}

export async function cosmeticModifier(service: Host) {
  directives = values(await service.GetValue('directive'))
    .linq.select(directive => directive)
    .linq.where(directive => isWhereCommandDirective(directive) || isWhereModelDirective(directive))
    .linq.toArray();

  return processCodeModel(tweakModel, service);
}

async function tweakModel(model: codemodel.Model, service: Host): Promise<codemodel.Model> {

  for (const directive of directives) {
    const getParsedSelector = (selector: string | undefined): RegExp | undefined => {
      return selector ? isNotRegex(selector) ? new RegExp(`^${selector}$`, 'gi') : new RegExp(selector, 'gi') : undefined;
    }

    if (isWhereCommandDirective(directive)) {
      const nounRegex = getParsedSelector(directive.where.noun);
      const verbRegex = getParsedSelector(directive.where.verb);
      const variantRegex = getParsedSelector(directive.where.variant);
      const parameterRegex = getParsedSelector(directive.where["parameter-name"]);

      const nounReplacer = directive.set.noun;
      const verbReplacer = directive.set.verb;
      const variantReplacer = directive.set.variant;
      const parameterReplacer = directive.set["parameter-name"];
      const paramDescriptionReplacer = directive.set["parameter-description"];

      // select all operations
      let operations: Array<CommandOperation> = values(model.commands.operations).linq.toArray();
      if (nounRegex) {
        operations = values(operations)
          .linq.where(operation =>
            !!`${operation.details.csharp.noun}`.match(nounRegex))
          .linq.toArray();
      }

      if (verbRegex) {
        operations = values(operations)
          .linq.where(operation =>
            !!`${operation.details.csharp.verb}`.match(verbRegex))
          .linq.toArray();
      }

      if (variantRegex) {
        operations = values(operations)
          .linq.where(operation =>
            !!`${operation.details.csharp.name}`.match(variantRegex))
          .linq.toArray();
      }

      if (parameterRegex) {
        const parameters = values(operations)
          .linq.selectMany(operation => allVirtualParameters(operation.details.csharp.virtualParameters))
          .linq.where(parameter => !!`${parameter.name}`.match(parameterRegex))
          .linq.toArray();
        for (const parameter of parameters) {
          const prevName = parameter.name;
          parameter.name = parameterReplacer ? parameterRegex ? parameter.name.replace(parameterRegex, parameterReplacer) : parameterReplacer : parameter.name;
          parameter.description = paramDescriptionReplacer ? paramDescriptionReplacer : parameter.description;
          if (parameterReplacer) {
            service.Message({
              Channel: Channel.Verbose, Text: `Changed parameter-name from ${prevName} to ${parameter.name}.`
            });
          }

          if (paramDescriptionReplacer) {
            service.Message({
              Channel: Channel.Verbose, Text: `Set parameter-description from parameter ${parameter.name}.`
            });
          }

        }

      } else if (operations) {
        for (const operation of operations) {
          const prevNoun = operation.details.csharp.noun;
          const prevVerb = operation.details.csharp.verb;
          const prevVariantName = operation.details.csharp.name;
          const oldCommandName = `${prevVerb}-${prevVariantName ? `${prevNoun}_${prevVariantName}` : prevNoun}`;

          // set values
          operation.details.csharp.noun = nounReplacer ? nounRegex ? prevNoun.replace(nounRegex, nounReplacer) : nounReplacer : prevNoun;
          operation.details.csharp.verb = verbReplacer ? verbRegex ? prevVerb.replace(verbRegex, verbReplacer) : verbReplacer : prevVerb;
          operation.details.csharp.name = variantReplacer ? variantRegex ? prevVariantName.replace(variantRegex, variantReplacer) : variantReplacer : prevVariantName;
          operation.details.csharp.hidden = (directive.set.hidden !== undefined) ? !!directive.set.hidden : operation.details.csharp.hidden;

          const newNoun = operation.details.csharp.noun;
          const newVerb = operation.details.csharp.verb;
          const newVariantName = operation.details.csharp.name;
          const newCommandName = `${newVerb}-${newVariantName ? `${newNoun}_${newVariantName}` : newNoun}`;

          if (nounReplacer || verbReplacer || variantReplacer) {
            let modificationMessage = `Changed command from ${oldCommandName} to ${newCommandName}. `
            service.Message({
              Channel: Channel.Verbose, Text: modificationMessage
            });
          }
        }
      }

      continue;
    }

    if (isWhereModelDirective(directive)) {
      const modelNameRegex = getParsedSelector(directive.where["model-name"]);
      const propertyNameRegex = getParsedSelector(directive.where["property-name"]);

      const modelNameReplacer = directive.set["model-name"];
      const propertyNameReplacer = directive.set["property-name"];
      const propertyDescriptionReplacer = directive.set["property-description"];

      // select all models
      let models = values(model.schemas).linq.toArray();
      if (modelNameRegex) {
        models = values(models)
          .linq.where(model =>
            !!`${model.details.csharp.name}`.match(modelNameRegex))
          .linq.toArray();
      }

      if (propertyNameRegex) {
        const properties = values(models)
          .linq.selectMany(model => allVirtualProperties(model.details.csharp.virtualProperties))
          .linq.where(property => !!`${property.name}`.match(propertyNameRegex))
          .linq.toArray();
        for (const property of properties) {
          const prevName = property.name;
          property.name = propertyNameReplacer ? propertyNameRegex ? property.name.replace(propertyNameRegex, propertyNameReplacer) : propertyNameReplacer : property.name;
          property.description = propertyDescriptionReplacer ? propertyDescriptionReplacer : property.description;

          if (propertyNameRegex) {
            service.Message({
              Channel: Channel.Verbose, Text: `Changed property-name from ${prevName} to ${property.name}.`
            });
          }
        }

      } else if (models) {
        for (const model of models) {
          const prevName = model.details.csharp.name;
          model.details.csharp.name = modelNameReplacer ? modelNameRegex ? model.details.csharp.name.replace(modelNameRegex, modelNameReplacer) : modelNameReplacer : model.details.csharp.name; service.Message({
            Channel: Channel.Verbose, Text: `Changed model-name from ${prevName} to ${model.details.csharp.name}.`
          });
        }
      }

      continue;
    }
  }

  return model;
}

function isNotRegex(str: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(str);
}
