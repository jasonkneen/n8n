import { inTest, isContainedWithin, Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Container, Service } from '@n8n/di';
import glob from 'fast-glob';
import fsPromises from 'fs/promises';
import type { Class, DirectoryLoader, Types } from 'n8n-core';
import {
	CUSTOM_EXTENSION_ENV,
	ErrorReporter,
	InstanceSettings,
	CustomDirectoryLoader,
	PackageDirectoryLoader,
	LazyPackageDirectoryLoader,
	UnrecognizedCredentialTypeError,
	UnrecognizedNodeTypeError,
} from 'n8n-core';
import type {
	KnownNodesAndCredentials,
	INodeTypeBaseDescription,
	INodeTypeDescription,
	LoadedClass,
	ICredentialType,
	INodeType,
	IVersionedNodeType,
	INodeProperties,
	LoadedNodesAndCredentials,
} from 'n8n-workflow';
import { deepCopy, NodeConnectionTypes, UnexpectedError, UserError } from 'n8n-workflow';
import { type Stats } from 'node:fs';
import path from 'path';
import picocolors from 'picocolors';

import { CUSTOM_API_CALL_KEY, CUSTOM_API_CALL_NAME, CLI_DIR, inE2ETests } from '@/constants';
import { CommunityPackagesConfig } from './community-packages/community-packages.config';

@Service()
export class LoadNodesAndCredentials {
	private known: KnownNodesAndCredentials = { nodes: {}, credentials: {} };

	// This contains the actually loaded objects, and their source paths
	loaded: LoadedNodesAndCredentials = { nodes: {}, credentials: {} };

	// For nodes, this only contains the descriptions, loaded from either the
	// actual file, or the lazy loaded json
	types: Types = { nodes: [], credentials: [] };

	loaders: Record<string, DirectoryLoader> = {};

	excludeNodes = this.globalConfig.nodes.exclude;

	includeNodes = this.globalConfig.nodes.include;

	private postProcessors: Array<() => Promise<void>> = [];

	constructor(
		private readonly logger: Logger,
		private readonly errorReporter: ErrorReporter,
		private readonly instanceSettings: InstanceSettings,
		private readonly globalConfig: GlobalConfig,
	) {}

	async init() {
		if (inTest) throw new UnexpectedError('Not available in tests');

		// Make sure the imported modules can resolve dependencies fine.
		const delimiter = process.platform === 'win32' ? ';' : ':';
		process.env.NODE_PATH = module.paths.join(delimiter);

		// @ts-ignore
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		module.constructor._initPaths();

		if (!inE2ETests) {
			this.excludeNodes = this.excludeNodes ?? [];
			this.excludeNodes.push('n8n-nodes-base.e2eTest');
		}

		// Load nodes from `n8n-nodes-base`
		const basePathsToScan = [
			// In case "n8n" package is in same node_modules folder.
			path.join(CLI_DIR, '..'),
			// In case "n8n" package is the root and the packages are
			// in the "node_modules" folder underneath it.
			path.join(CLI_DIR, 'node_modules'),
		];

		for (const nodeModulesDir of basePathsToScan) {
			await this.loadNodesFromNodeModules(nodeModulesDir, 'n8n-nodes-base');
			await this.loadNodesFromNodeModules(nodeModulesDir, '@n8n/n8n-nodes-langchain');
		}

		if (!Container.get(CommunityPackagesConfig).preventLoading) {
			// Load nodes from any other `n8n-nodes-*` packages in the download directory
			// This includes the community nodes
			await this.loadNodesFromNodeModules(
				path.join(this.instanceSettings.nodesDownloadDir, 'node_modules'),
			);
		}

		await this.loadNodesFromCustomDirectories();
		await this.postProcessLoaders();
	}

	addPostProcessor(fn: () => Promise<void>) {
		this.postProcessors.push(fn);
	}

	isKnownNode(type: string) {
		return type in this.known.nodes;
	}

	get loadedCredentials() {
		return this.loaded.credentials;
	}

	get loadedNodes() {
		return this.loaded.nodes;
	}

	get knownCredentials() {
		return this.known.credentials;
	}

	get knownNodes() {
		return this.known.nodes;
	}

	private async loadNodesFromNodeModules(
		nodeModulesDir: string,
		packageName?: string,
	): Promise<void> {
		const globOptions = {
			cwd: nodeModulesDir,
			onlyDirectories: true,
			deep: 1,
		};
		const installedPackagePaths = packageName
			? await glob(packageName, globOptions)
			: [
					...(await glob('n8n-nodes-*', globOptions)),
					...(await glob('@*/n8n-nodes-*', { ...globOptions, deep: 2 })),
				];

		for (const packagePath of installedPackagePaths) {
			try {
				await this.runDirectoryLoader(
					LazyPackageDirectoryLoader,
					path.join(nodeModulesDir, packagePath),
				);
			} catch (error) {
				this.logger.error((error as Error).message);
				this.errorReporter.error(error);
			}
		}
	}

	resolveIcon(packageName: string, url: string): string | undefined {
		const loader = this.loaders[packageName];
		if (!loader) {
			return undefined;
		}
		const pathPrefix = `/icons/${packageName}/`;
		const filePath = path.resolve(loader.directory, url.substring(pathPrefix.length));

		return isContainedWithin(loader.directory, filePath) ? filePath : undefined;
	}

	resolveSchema({
		node,
		version,
		resource,
		operation,
	}: {
		node: string;
		version: string;
		resource?: string;
		operation?: string;
	}): string | undefined {
		const nodePath = this.known.nodes[node]?.sourcePath;
		if (!nodePath) {
			return undefined;
		}

		const nodeParentPath = path.dirname(nodePath);
		const schemaPath = ['__schema__', `v${version}`, resource, operation].filter(Boolean).join('/');
		const filePath = path.resolve(nodeParentPath, schemaPath + '.json');

		return isContainedWithin(nodeParentPath, filePath) ? filePath : undefined;
	}

	getCustomDirectories(): string[] {
		const customDirectories = [this.instanceSettings.customExtensionDir];

		if (process.env[CUSTOM_EXTENSION_ENV] !== undefined) {
			const customExtensionFolders = process.env[CUSTOM_EXTENSION_ENV].split(';');
			customDirectories.push(...customExtensionFolders);
		}

		return customDirectories;
	}

	private async loadNodesFromCustomDirectories(): Promise<void> {
		for (const directory of this.getCustomDirectories()) {
			await this.runDirectoryLoader(CustomDirectoryLoader, directory);
		}
	}

	async loadPackage(packageName: string) {
		const finalNodeUnpackedPath = path.join(
			this.instanceSettings.nodesDownloadDir,
			'node_modules',
			packageName,
		);
		return await this.runDirectoryLoader(PackageDirectoryLoader, finalNodeUnpackedPath);
	}

	async unloadPackage(packageName: string) {
		if (packageName in this.loaders) {
			this.loaders[packageName].reset();
			delete this.loaders[packageName];
		}
	}

	/**
	 * Whether any of the node's credential types may be used to
	 * make a request from a node other than itself.
	 */
	private supportsProxyAuth(description: INodeTypeDescription) {
		if (!description.credentials) return false;

		return description.credentials.some(({ name }) => {
			const credType = this.types.credentials.find((t) => t.name === name);
			if (!credType) {
				this.logger.warn(
					`Failed to load Custom API options for the node "${description.name}": Unknown credential name "${name}"`,
				);
				return false;
			}
			if (credType.authenticate !== undefined) return true;

			return (
				Array.isArray(credType.extends) &&
				credType.extends.some((parentType) =>
					['oAuth2Api', 'googleOAuth2Api', 'oAuth1Api'].includes(parentType),
				)
			);
		});
	}

	/**
	 * Inject a `Custom API Call` option into `resource` and `operation`
	 * parameters in a latest-version node that supports proxy auth.
	 */
	private injectCustomApiCallOptions() {
		this.types.nodes.forEach((node: INodeTypeDescription) => {
			const isLatestVersion =
				node.defaultVersion === undefined || node.defaultVersion === node.version;

			if (isLatestVersion) {
				if (!this.supportsProxyAuth(node)) return;

				node.properties.forEach((p) => {
					if (
						['resource', 'operation'].includes(p.name) &&
						Array.isArray(p.options) &&
						p.options[p.options.length - 1].name !== CUSTOM_API_CALL_NAME
					) {
						p.options.push({
							name: CUSTOM_API_CALL_NAME,
							value: CUSTOM_API_CALL_KEY,
						});
					}
				});
			}
		});
	}

	/**
	 * Run a loader of source files of nodes and credentials in a directory.
	 */
	private async runDirectoryLoader<T extends DirectoryLoader>(
		constructor: Class<T, ConstructorParameters<typeof DirectoryLoader>>,
		dir: string,
	) {
		const loader = new constructor(dir, this.excludeNodes, this.includeNodes);
		if (loader instanceof PackageDirectoryLoader && loader.packageName in this.loaders) {
			throw new UserError(
				picocolors.red(
					`nodes package ${loader.packageName} is already loaded.\n Please delete this second copy at path ${dir}`,
				),
			);
		}
		await loader.loadAll();
		this.loaders[loader.packageName] = loader;
		return loader;
	}

	/**
	 * This creates all AI Agent tools by duplicating the node descriptions for
	 * all nodes that are marked as `usableAsTool`. It basically modifies the
	 * description. The actual wrapping happens in the langchain code for getting
	 * the connected tools.
	 */
	createAiTools() {
		const usableNodes: Array<INodeTypeBaseDescription | INodeTypeDescription> =
			this.types.nodes.filter((nodeType) => nodeType.usableAsTool);

		for (const usableNode of usableNodes) {
			const description =
				typeof usableNode.usableAsTool === 'object'
					? ({
							...deepCopy(usableNode),
							...usableNode.usableAsTool?.replacements,
						} as INodeTypeBaseDescription)
					: deepCopy(usableNode);
			const wrapped = this.convertNodeToAiTool({ description }).description;

			this.types.nodes.push(wrapped);
			this.known.nodes[wrapped.name] = { ...this.known.nodes[usableNode.name] };

			const credentialNames = Object.entries(this.known.credentials)
				.filter(([_, credential]) => credential?.supportedNodes?.includes(usableNode.name))
				.map(([credentialName]) => credentialName);

			credentialNames.forEach((name) =>
				this.known.credentials[name]?.supportedNodes?.push(wrapped.name),
			);
		}
	}

	async postProcessLoaders() {
		this.known = { nodes: {}, credentials: {} };
		this.loaded = { nodes: {}, credentials: {} };
		this.types = { nodes: [], credentials: [] };

		for (const loader of Object.values(this.loaders)) {
			// list of node & credential types that will be sent to the frontend
			const { known, types, directory, packageName } = loader;
			this.types.nodes = this.types.nodes.concat(
				types.nodes.map(({ name, ...rest }) => ({
					...rest,
					name: `${packageName}.${name}`,
				})),
			);
			this.types.credentials = this.types.credentials.concat(
				types.credentials.map(({ supportedNodes, ...rest }) => ({
					...rest,
					supportedNodes:
						loader instanceof PackageDirectoryLoader
							? supportedNodes?.map((nodeName) => `${loader.packageName}.${nodeName}`)
							: undefined,
				})),
			);

			// Nodes and credentials that have been loaded immediately
			for (const nodeTypeName in loader.nodeTypes) {
				this.loaded.nodes[`${packageName}.${nodeTypeName}`] = loader.nodeTypes[nodeTypeName];
			}

			for (const credentialTypeName in loader.credentialTypes) {
				this.loaded.credentials[credentialTypeName] = loader.credentialTypes[credentialTypeName];
			}

			for (const type in known.nodes) {
				const { className, sourcePath } = known.nodes[type];
				this.known.nodes[`${packageName}.${type}`] = {
					className,
					sourcePath: path.join(directory, sourcePath),
				};
			}

			for (const type in known.credentials) {
				const {
					className,
					sourcePath,
					supportedNodes,
					extends: extendsArr,
				} = known.credentials[type];
				this.known.credentials[type] = {
					className,
					sourcePath: path.join(directory, sourcePath),
					supportedNodes:
						loader instanceof PackageDirectoryLoader
							? supportedNodes?.map((nodeName) => `${loader.packageName}.${nodeName}`)
							: undefined,
					extends: extendsArr,
				};
			}
		}

		this.createAiTools();

		this.injectCustomApiCallOptions();

		for (const postProcessor of this.postProcessors) {
			await postProcessor();
		}
	}

	recognizesNode(fullNodeType: string): boolean {
		const [packageName, nodeType] = fullNodeType.split('.');
		const { loaders } = this;
		const loader = loaders[packageName];
		return !!loader && nodeType in loader.known.nodes;
	}

	getNode(fullNodeType: string): LoadedClass<INodeType | IVersionedNodeType> {
		const [packageName, nodeType] = fullNodeType.split('.');
		const { loaders } = this;
		const loader = loaders[packageName];
		if (!loader) {
			throw new UnrecognizedNodeTypeError(packageName, nodeType);
		}
		return loader.getNode(nodeType);
	}

	getCredential(credentialType: string): LoadedClass<ICredentialType> {
		const { loadedCredentials } = this;

		for (const loader of Object.values(this.loaders)) {
			if (credentialType in loader.known.credentials) {
				const loaded = loader.getCredential(credentialType);
				loadedCredentials[credentialType] = loaded;
			}
		}

		if (credentialType in loadedCredentials) {
			return loadedCredentials[credentialType];
		}

		throw new UnrecognizedCredentialTypeError(credentialType);
	}

	/**
	 * Modifies the description of the passed in object, such that it can be used
	 * as an AI Agent Tool.
	 * Returns the modified item (not copied)
	 */
	convertNodeToAiTool<
		T extends object & { description: INodeTypeDescription | INodeTypeBaseDescription },
	>(item: T): T {
		// quick helper function for type-guard down below
		function isFullDescription(obj: unknown): obj is INodeTypeDescription {
			return typeof obj === 'object' && obj !== null && 'properties' in obj;
		}

		if (isFullDescription(item.description)) {
			item.description.name += 'Tool';
			item.description.inputs = [];
			item.description.outputs = [NodeConnectionTypes.AiTool];
			item.description.displayName += ' Tool';
			delete item.description.usableAsTool;

			const hasResource = item.description.properties.some((prop) => prop.name === 'resource');
			const hasOperation = item.description.properties.some((prop) => prop.name === 'operation');

			if (!item.description.properties.map((prop) => prop.name).includes('toolDescription')) {
				const descriptionType: INodeProperties = {
					displayName: 'Tool Description',
					name: 'descriptionType',
					type: 'options',
					noDataExpression: true,
					options: [
						{
							name: 'Set Automatically',
							value: 'auto',
							description: 'Automatically set based on resource and operation',
						},
						{
							name: 'Set Manually',
							value: 'manual',
							description: 'Manually set the description',
						},
					],
					default: 'auto',
				};

				const descProp: INodeProperties = {
					displayName: 'Description',
					name: 'toolDescription',
					type: 'string',
					default: item.description.description,
					required: true,
					typeOptions: { rows: 2 },
					description:
						'Explain to the LLM what this tool does, a good, specific description would allow LLMs to produce expected results much more often',
				};

				item.description.properties.unshift(descProp);

				// If node has resource or operation we can determine pre-populate tool description based on it
				// so we add the descriptionType property as the first property
				if (hasResource || hasOperation) {
					item.description.properties.unshift(descriptionType);

					descProp.displayOptions = {
						show: {
							descriptionType: ['manual'],
						},
					};
				}
			}
		}

		const resources = item.description.codex?.resources ?? {};

		item.description.codex = {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
				Tools: item.description.codex?.subcategories?.Tools ?? ['Other Tools'],
			},
			resources,
		};
		return item;
	}

	async setupHotReload() {
		const { default: debounce } = await import('lodash/debounce');

		const { watch } = await import('chokidar');

		const { Push } = await import('@/push');
		const push = Container.get(Push);

		Object.values(this.loaders).forEach(async (loader) => {
			const { directory } = loader;
			try {
				await fsPromises.access(directory);
			} catch {
				// If directory doesn't exist, there is nothing to watch
				return;
			}

			const reloader = debounce(async () => {
				this.logger.info(`Hot reload triggered for ${loader.packageName}`);
				try {
					loader.reset();
					await loader.loadAll();
					await this.postProcessLoaders();
					push.broadcast({ type: 'nodeDescriptionUpdated', data: {} });
				} catch (error) {
					this.logger.error(`Hot reload failed for ${loader.packageName}`);
				}
			}, 100);

			// For lazy loaded packages, we need to watch the dist directory
			const watchPath = loader.isLazyLoaded ? path.join(directory, 'dist') : directory;

			// Watch options for chokidar v4
			const watchOptions = {
				ignoreInitial: true,
				cwd: directory,
				// Filter which files to watch based on loader type
				ignored: (filePath: string, stats?: Stats) => {
					if (!stats) return false;
					if (stats.isDirectory()) return false;
					if (filePath.includes('node_modules')) return true;

					if (loader.isLazyLoaded) {
						// Only watch nodes.json and credentials.json files
						const basename = path.basename(filePath);
						return basename !== 'nodes.json' && basename !== 'credentials.json';
					}

					// Watch all .js and .json files
					return !filePath.endsWith('.js') && !filePath.endsWith('.json');
				},
			};

			const watcher = watch(watchPath, watchOptions);

			// Watch for file changes and additions
			// Not watching removals to prevent issues during build processes
			watcher.on('change', reloader);
			watcher.on('add', reloader);
		});
	}
}
