import { Container } from 'typedi';
import { Flags } from '@oclif/core';
import { ApplicationError, jsonParse } from 'n8n-workflow';
import fs from 'fs';
import glob from 'fast-glob';

import { UM_FIX_INSTRUCTION } from '@/constants';
import { WorkflowEntity } from '@db/entities/WorkflowEntity';
import { disableAutoGeneratedIds } from '@db/utils/commandHelpers';
import { generateNanoId } from '@db/utils/generators';
import { UserRepository } from '@db/repositories/user.repository';
import { WorkflowRepository } from '@db/repositories/workflow.repository';
import type { IWorkflowToImport } from '@/Interfaces';
import { ImportService } from '@/services/import.service';
import { BaseCommand } from '../BaseCommand';
import { SharedWorkflowRepository } from '@db/repositories/sharedWorkflow.repository';

function assertHasWorkflowsToImport(workflows: unknown): asserts workflows is IWorkflowToImport[] {
	if (!Array.isArray(workflows)) {
		throw new ApplicationError(
			'File does not seem to contain workflows. Make sure the workflows are contained in an array.',
		);
	}

	for (const workflow of workflows) {
		if (
			typeof workflow !== 'object' ||
			!Object.prototype.hasOwnProperty.call(workflow, 'nodes') ||
			!Object.prototype.hasOwnProperty.call(workflow, 'connections')
		) {
			throw new ApplicationError('File does not seem to contain valid workflows.');
		}
	}
}

export class ImportWorkflowsCommand extends BaseCommand {
	static description = 'Import workflows';

	static examples = [
		'$ n8n import:workflow --input=file.json',
		'$ n8n import:workflow --separate --input=backups/latest/',
		'$ n8n import:workflow --input=file.json --userId=1d64c3d2-85fe-4a83-a649-e446b07b3aae',
		'$ n8n import:workflow --separate --input=backups/latest/ --userId=1d64c3d2-85fe-4a83-a649-e446b07b3aae',
	];

	static flags = {
		help: Flags.help({ char: 'h' }),
		input: Flags.string({
			char: 'i',
			description: 'Input file name or directory if --separate is used',
		}),
		separate: Flags.boolean({
			description: 'Imports *.json files from directory provided by --input',
		}),
		userId: Flags.string({
			description: 'The ID of the user to assign the imported workflows to',
		}),
	};

	async init() {
		disableAutoGeneratedIds(WorkflowEntity);
		await super.init();
	}

	async run(): Promise<void> {
		const { flags } = await this.parse(ImportWorkflowsCommand);

		if (!flags.input) {
			this.logger.info('An input file or directory with --input must be provided');
			return;
		}

		if (flags.separate) {
			if (fs.existsSync(flags.input)) {
				if (!fs.lstatSync(flags.input).isDirectory()) {
					this.logger.info('The argument to --input must be a directory');
					return;
				}
			}
		}

		const owner = await this.getOwner();

		const workflows = await this.readWorkflows(flags.input, flags.separate);

		const result = await this.checkRelations(workflows, flags.userId);
		if (!result.success) {
			throw new ApplicationError(result.message);
		}

		this.logger.info(`Importing ${workflows.length} workflows...`);

		await Container.get(ImportService).importWorkflows(workflows, flags.userId ?? owner.id);

		this.reportSuccess(workflows.length);
	}

	private async checkRelations(workflows: WorkflowEntity[], userId: string | undefined) {
		if (!userId) {
			return {
				success: true as const,
				message: undefined,
			};
		}

		for (const workflow of workflows) {
			if (!(await this.workflowExists(workflow))) {
				continue;
			}

			const ownerId = await this.getWorkflowOwner(workflow);
			if (!ownerId) {
				continue;
			}

			if (ownerId !== userId) {
				return {
					success: false as const,
					message: `The credential with id "${workflow.id}" is already owned by the project with the id "${ownerId}". It can't be re-owned by the user with the id "${userId}"`,
				};
			}
		}

		return {
			success: true as const,
			message: undefined,
		};
	}

	async catch(error: Error) {
		this.logger.error('An error occurred while importing workflows. See log messages for details.');
		this.logger.error(error.message);
	}

	private reportSuccess(total: number) {
		this.logger.info(`Successfully imported ${total} ${total === 1 ? 'workflow.' : 'workflows.'}`);
	}

	private async getOwner() {
		const owner = await Container.get(UserRepository).findOneBy({ role: 'global:owner' });
		if (!owner) {
			throw new ApplicationError(`Failed to find owner. ${UM_FIX_INSTRUCTION}`);
		}

		return owner;
	}

	private async getWorkflowOwner(workflow: WorkflowEntity) {
		const sharing = await Container.get(SharedWorkflowRepository).findOneBy({
			workflowId: workflow.id,
			role: 'workflow:owner',
		});

		return sharing?.projectId;
	}

	private async workflowExists(workflow: WorkflowEntity) {
		return await Container.get(WorkflowRepository).existsBy({ id: workflow.id });
	}

	private async readWorkflows(path: string, separate: boolean): Promise<WorkflowEntity[]> {
		if (process.platform === 'win32') {
			path = path.replace(/\\/g, '/');
		}

		if (separate) {
			const files = await glob('*.json', {
				cwd: path,
				absolute: true,
			});
			const workflowInstances = files.map((file) => {
				const workflow = jsonParse<IWorkflowToImport>(fs.readFileSync(file, { encoding: 'utf8' }));
				if (!workflow.id) {
					workflow.id = generateNanoId();
				}

				const workflowInstance = Container.get(WorkflowRepository).create(workflow);

				return workflowInstance;
			});

			return workflowInstances;
		} else {
			const workflows = jsonParse<IWorkflowToImport[]>(fs.readFileSync(path, { encoding: 'utf8' }));

			const workflowInstances = workflows.map((w) => Container.get(WorkflowRepository).create(w));
			assertHasWorkflowsToImport(workflows);

			return workflowInstances;
		}
	}
}
