/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { codemodel } from '@microsoft.azure/autorest.codemodel-v3';
import { deserialize, applyOverrides, copyResources, copyBinaryResources, safeEval } from '@microsoft.azure/codegen';
import { Host } from '@microsoft.azure/autorest-extension-base';
import { join } from 'path';
import { Project } from './project';
import { State } from './state';
import { generatePsd1 } from './generators/psd1';
import { generatePsm1 } from './generators/psm1';
import { generateCsproj } from './generators/csproj';
import { generatePsm1Custom } from './generators/psm1.custom';
import { generatePsm1Internal } from './generators/psm1.internal';
import { generateNuspec } from './generators/nuspec';
import { generateGitIgnore } from './generators/gitignore';
import { generateGitAttributes } from './generators/gitattributes';

const sourceFileCSharp = 'source-file-csharp';
const resources = `${__dirname}/../resources`;

export async function powershell(service: Host) {
  try {
    // Get the list of files
    const files = await service.ListInputs('code-model-v3');
    if (files.length === 0) {
      throw new Error('Inputs missing.');
    }

    const codemodel = files[0];

    // get the openapi document
    const codeModelText = await service.ReadFile(codemodel);
    const model = await deserialize<codemodel.Model>(codeModelText, codemodel);

    // generate some files
    const modelState = new State(service, model, codemodel);
    const project = await new Project(modelState).init();

    await project.writeFiles(async (filename, content) => service.WriteFile(filename, applyOverrides(content, project.overrides), undefined, sourceFileCSharp));

    await service.ProtectFiles(project.psd1);
    await service.ProtectFiles(project.customFolder);
    await service.ProtectFiles(project.testFolder);
    await service.ProtectFiles(project.docsFolder);
    await service.ProtectFiles(project.examplesFolder);

    // wait for all the generation to be done
    await copyRequiredFiles(service, project);
    await generateCsproj(service, project);
    await generatePsd1(service, project);
    await generatePsm1(service, project);
    await generatePsm1Custom(service, project);
    await generatePsm1Internal(service, project);
    await generateNuspec(service, project);
    await generateGitIgnore(service, project);
    await generateGitAttributes(service, project);

  } catch (E) {
    console.error(`${__filename} - FAILURE  ${JSON.stringify(E)} ${E.stack}`);
    throw E;
  }
}

async function copyRequiredFiles(service: Host, project: Project) {

  const cache = new Array<any>();
  const replacer = (key: string, value: any) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.indexOf(value) !== -1) {
        // Duplicate reference found
        try {
          // If this value does not reference a parent it can be deduped
          return JSON.parse(JSON.stringify(value));
        } catch (error) {
          // discard key if value cannot be deduped
          return;
        }
      }
      // Store value in our collection
      cache.push(value);
    }
    return value;
  }

  const transformOutput = async (input: string) => {
    let rx = /\$\{(.*?)\}/g;
    let output = input;

    for (let match; match = rx.exec(input);) {
      const text = match[0];
      const inner = match[1];
      let value = await service.GetValue(inner);
      if (value === null || value === undefined) {
        // try as a safe eval execution.
        try {
          value = safeEval(inner, {
            $config: await service.GetValue(''),
            $project: project,
            $lib: {
              path: require('path')
            }
          });
        }
        catch {
          value = null;
        }
      }
      if (value !== undefined && value !== null) {
        if (typeof value === 'object') {
          value = JSON.stringify(value, replacer, 2);
        }
        if (value === '{}') {
          value = 'true';
        }
        output = output.replace(text, value);
      }
    }
    return output;
  };

  // Project assets
  await copyResources(join(resources, 'assets'), async (fname, content) => service.WriteFile(fname, content, undefined, 'source-file-other'), undefined, transformOutput);

  // Runtime files
  await copyResources(join(resources, 'runtime'), async (fname, content) => service.WriteFile(join(project.runtimeFolder, fname), content, undefined, sourceFileCSharp), project.overrides, transformOutput);

  // Modules files
  await copyBinaryResources(join(resources, 'modules'), async (fname, content) => service.WriteFile(join(project.dependencyModuleFolder, fname), content, undefined, 'binary-file'));

  if (project.azure) {
    // Signing key file
    await copyBinaryResources(join(resources, 'signing'), async (fname, content) => service.WriteFile(join(project.baseFolder, fname), content, undefined, 'binary-file'));
  }
}

