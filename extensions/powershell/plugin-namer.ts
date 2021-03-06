/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Host, Channel } from '@microsoft.azure/autorest-extension-base';
import { codemodel, processCodeModel, allVirtualParameters, allVirtualProperties, resolveParameterNames, resolvePropertyNames } from '@microsoft.azure/autorest.codemodel-v3';
import { deconstruct, fixLeadingNumber, pascalCase, values, removeProhibitedPrefix, getPascalIdentifier } from '@microsoft.azure/codegen';
import * as linq from '@microsoft.azure/linq';
import { singularize } from './name-inferrer';

// well-known parameters to singularize
const namesToSingularize = new Set<string>([
  'Tags'
]);

export async function namer(service: Host) {
  return processCodeModel(tweakModel, service);
}

async function tweakModel(model: codemodel.Model, service: Host): Promise<codemodel.Model> {
  // get the value 
  const isAzure = !!await service.GetValue('azure') || !!await service.GetValue('azure-arm') || false;
  const shouldSanitize = !!await service.GetValue('sanitize-names');

  // make sure recursively that every details field has csharp
  for (const { index, instance } of linq.visitor(model)) {
    if (index === 'details' && instance.default && !instance.csharp) {
      instance.csharp = linq.clone(instance.default, false, undefined, undefined, ['schema']);
    }
  }

  if (shouldSanitize || isAzure) {
    for (const operation of values(model.commands.operations)) {
      const virtualParameters = [...allVirtualParameters(operation.details.csharp.virtualParameters)]
      for (const parameter of virtualParameters) {
        // save previous name as alias
        const prevName = parameter.name;
        const otherParametersNames = values(virtualParameters)
          .linq.select(each => each.name)
          .linq.where(name => name !== parameter.name)
          .linq.toArray();

        const sanitizedName = removeProhibitedPrefix(
          parameter.name,
          operation.details.csharp.noun,
          otherParametersNames
        );

        if (prevName !== sanitizedName) {
          if (parameter.alias === undefined) {
            parameter.alias = [];
          }

          parameter.alias.push(parameter.name);

          // change name
          parameter.name = sanitizedName;
          service.Message({ Channel: Channel.Verbose, Text: `Sanitized name -> Changed parameter-name ${prevName} to ${parameter.name} from command ${operation.verb}-${operation.details.csharp.noun}` });
        } else if (namesToSingularize.has(parameter.name) && isAzure) {
          if (parameter.alias === undefined) {
            parameter.alias = [];
          }

          parameter.alias.push(parameter.name);

          // change name
          parameter.name = singularize(parameter.name);
          service.Message({ Channel: Channel.Verbose, Text: `Well-Know Azure parameter rename ->  Changed parameter-name ${prevName} to ${parameter.name} from command ${operation.verb}-${operation.details.csharp.noun}` });
        }
      }
    }

    for (const schema of values(model.schemas)) {
      const virtualProperties = [...allVirtualProperties(schema.details.csharp.virtualProperties)];

      for (const property of virtualProperties) {
        // save previous name as alias
        const otherPropertiesNames = values(virtualProperties)
          .linq.select(each => each.name)
          .linq.where(name => name !== property.name)
          .linq.toArray();

        const sanitizedName = removeProhibitedPrefix(
          property.name,
          schema.details.csharp.name,
          otherPropertiesNames
        );

        if (property.name !== sanitizedName) {
          // apply alias
          const prevName = property.name;
          if (property.alias === undefined) {
            property.alias = [];
          }

          property.alias.push(property.name);

          // change name
          property.name = sanitizedName;
          service.Message({ Channel: Channel.Verbose, Text: `Sanitized name -> Changed property-name ${prevName} to ${property.name} from model ${schema.details.csharp.name}` });
        } else if (namesToSingularize.has(property.name) && isAzure) {
          // apply alias
          const prevName = property.name;
          if (property.alias === undefined) {
            property.alias = [];
          }

          property.alias.push(prevName);

          // change name
          property.name = singularize(property.name);
          service.Message({ Channel: Channel.Verbose, Text: `Well-Know Azure property rename -> Changed property-name ${prevName} to ${property.name} from model ${schema.details.csharp.name}` });
        }
      }
    }
  }

  // do collision detection work.
  for (const command of values(model.commands.operations)) {
    const vp = command.details.csharp.virtualParameters;
    if (vp) {
      resolveParameterNames([], vp);
    }
  }

  for (const schema of values(model.schemas)) {
    const vp = schema.details.csharp.virtualProperties;
    if (vp) {
      resolvePropertyNames([schema.details.csharp.name], vp);
    }
  }
  return model;
}
