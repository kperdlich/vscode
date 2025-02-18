/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { ILanguageDetectionService, ILanguageDetectionStats, LanguageDetectionStatsClassification, LanguageDetectionStatsId } from 'vs/workbench/services/languageDetection/common/languageDetectionWorkerService';
import { FileAccess } from 'vs/base/common/network';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ILanguageService } from 'vs/editor/common/languages/language';
import { URI } from 'vs/base/common/uri';
import { isWeb } from 'vs/base/common/platform';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { LanguageDetectionSimpleWorker } from 'vs/workbench/services/languageDetection/browser/languageDetectionSimpleWorker';
import { IModelService } from 'vs/editor/common/services/model';
import { SimpleWorkerClient } from 'vs/base/common/worker/simpleWorker';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { EditorWorkerClient, EditorWorkerHost } from 'vs/editor/browser/services/editorWorkerService';
import { ILanguageConfigurationService } from 'vs/editor/common/languages/languageConfigurationRegistry';
import { IDiagnosticsService } from 'vs/platform/diagnostics/common/diagnostics';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { LRUCache } from 'vs/base/common/map';

const regexpModuleLocation = '../../../../../../node_modules/vscode-regexp-languagedetection';
const regexpModuleLocationAsar = '../../../../../../node_modules.asar/vscode-regexp-languagedetection';
const moduleLocation = '../../../../../../node_modules/@vscode/vscode-languagedetection';
const moduleLocationAsar = '../../../../../../node_modules.asar/@vscode/vscode-languagedetection';

export class LanguageDetectionService extends Disposable implements ILanguageDetectionService {
	static readonly enablementSettingKey = 'workbench.editor.languageDetection';
	static readonly historyBasedEnablementConfig = 'workbench.editor.historyBasedLanguageDetection';
	static readonly openedLanguagesStorageKey = 'workbench.editor.languageDetectionOpenedLanguages';

	_serviceBrand: undefined;

	private _languageDetectionWorkerClient: LanguageDetectionWorkerClient;

	private hasResolvedWorkspaceLanguageIds = false;
	private workspaceLanguageIds = new Set<string>();
	private sessionOpenedLanguageIds = new Set<string>();
	private historicalGlobalOpenedLanguageIds = new LRUCache<string, true>(10);
	private historicalWorkspaceOpenedLanguageIds = new LRUCache<string, true>(10);

	constructor(
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDiagnosticsService private readonly _diagnosticsService: IDiagnosticsService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IModelService modelService: IModelService,
		@IEditorService private readonly _editorService: IEditorService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
		@ILanguageConfigurationService languageConfigurationService: ILanguageConfigurationService
	) {
		super();

		this._languageDetectionWorkerClient = new LanguageDetectionWorkerClient(
			modelService,
			telemetryService,
			// TODO: See if it's possible to bundle vscode-languagedetection
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri(`${moduleLocationAsar}/dist/lib/index.js`, require).toString(true)
				: FileAccess.asBrowserUri(`${moduleLocation}/dist/lib/index.js`, require).toString(true),
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri(`${moduleLocationAsar}/model/model.json`, require).toString(true)
				: FileAccess.asBrowserUri(`${moduleLocation}/model/model.json`, require).toString(true),
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri(`${moduleLocationAsar}/model/group1-shard1of1.bin`, require).toString(true)
				: FileAccess.asBrowserUri(`${moduleLocation}/model/group1-shard1of1.bin`, require).toString(true),
			this._environmentService.isBuilt && !isWeb
				? FileAccess.asBrowserUri(`${regexpModuleLocationAsar}/dist/index.js`, require).toString(true)
				: FileAccess.asBrowserUri(`${regexpModuleLocation}/dist/index.js`, require).toString(true),
			languageConfigurationService
		);

		this.initEditorOpenedListeners(storageService);
	}

	private resolveWorkspaceLanguageIds() {
		this.hasResolvedWorkspaceLanguageIds = true;
		this._diagnosticsService.getWorkspaceFileExtensions(this._workspaceContextService.getWorkspace()).then(fileExtensions => {
			fileExtensions.extensions.forEach(ext => {
				const langId = this.getLanguageId(ext);
				if (langId) {
					this.workspaceLanguageIds.add(langId);
				}
			});
		});
	}

	public isEnabledForLanguage(languageId: string): boolean {
		return !!languageId && this._configurationService.getValue<boolean>(LanguageDetectionService.enablementSettingKey, { overrideIdentifier: languageId });
	}

	private getLanguageId(language: string | undefined): string | undefined {
		if (!language) {
			return undefined;
		}
		if (this._languageService.isRegisteredLanguageId(language)) {
			return language;
		}
		return this._languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(`file.${language}`)) ?? undefined;
	}

	private getLanguageBiases(): Record<string, number> {
		const biases: Record<string, number> = {};

		// Give different weight to the biases depending on relevance of source
		this.sessionOpenedLanguageIds.forEach(lang =>
			biases[lang] = (biases[lang] ?? 0) + 4);

		this.workspaceLanguageIds.forEach(lang =>
			biases[lang] = (biases[lang] ?? 0) + 3);

		[...this.historicalWorkspaceOpenedLanguageIds.keys()].forEach(lang =>
			biases[lang] = (biases[lang] ?? 0) + 2);

		[...this.historicalGlobalOpenedLanguageIds.keys()].forEach(lang =>
			biases[lang] = (biases[lang] ?? 0) + 1);

		return biases;
	}

	async detectLanguage(resource: URI): Promise<string | undefined> {
		const useHistory = this._configurationService.getValue<string[]>(LanguageDetectionService.historyBasedEnablementConfig);
		if (useHistory && !this.hasResolvedWorkspaceLanguageIds) {
			// dont block on this, let further re-triggers get any new values
			this.resolveWorkspaceLanguageIds();
		}
		const biases = useHistory ? this.getLanguageBiases() : undefined;
		const language = await this._languageDetectionWorkerClient.detectLanguage(resource, biases);

		if (language) {
			return this.getLanguageId(language);
		}
		return undefined;
	}

	private initEditorOpenedListeners(storageService: IStorageService) {
		try {
			const globalLangHistroyData = JSON.parse(storageService.get(LanguageDetectionService.openedLanguagesStorageKey, StorageScope.GLOBAL, '[]'));
			this.historicalGlobalOpenedLanguageIds.fromJSON(globalLangHistroyData);
		} catch { }

		try {
			const workspaceLangHistroyData = JSON.parse(storageService.get(LanguageDetectionService.openedLanguagesStorageKey, StorageScope.WORKSPACE, '[]'));
			this.historicalGlobalOpenedLanguageIds.fromJSON(workspaceLangHistroyData);
		} catch { }

		this._register(this._editorService.onDidActiveEditorChange(() => {
			const activeLanguage = this._editorService.activeTextEditorLanguageId;
			if (activeLanguage) {
				this.sessionOpenedLanguageIds.add(activeLanguage);
				this.historicalGlobalOpenedLanguageIds.set(activeLanguage, true);
				this.historicalWorkspaceOpenedLanguageIds.set(activeLanguage, true);
				storageService.store(LanguageDetectionService.openedLanguagesStorageKey, JSON.stringify(this.historicalGlobalOpenedLanguageIds.toJSON()), StorageScope.GLOBAL, StorageTarget.MACHINE);
				storageService.store(LanguageDetectionService.openedLanguagesStorageKey, JSON.stringify(this.historicalWorkspaceOpenedLanguageIds.toJSON()), StorageScope.WORKSPACE, StorageTarget.USER);
			}
		}));
	}
}

export interface IWorkerClient<W> {
	getProxyObject(): Promise<W>;
	dispose(): void;
}

export class LanguageDetectionWorkerHost {
	constructor(
		private _indexJsUri: string,
		private _modelJsonUri: string,
		private _weightsUri: string,
		private _telemetryService: ITelemetryService,
	) {
	}

	async getIndexJsUri() {
		return this._indexJsUri;
	}

	async getModelJsonUri() {
		return this._modelJsonUri;
	}

	async getWeightsUri() {
		return this._weightsUri;
	}

	async sendTelemetryEvent(languages: string[], confidences: number[], timeSpent: number): Promise<void> {
		type LanguageDetectionStats = { languages: string; confidences: string; timeSpent: number };
		type LanguageDetectionStatsClassification = {
			languages: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
			confidences: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
			timeSpent: { classification: 'SystemMetaData'; purpose: 'FeatureInsight' };
		};

		this._telemetryService.publicLog2<LanguageDetectionStats, LanguageDetectionStatsClassification>('automaticlanguagedetection.stats', {
			languages: languages.join(','),
			confidences: confidences.join(','),
			timeSpent
		});
	}
}

export class LanguageDetectionWorkerClient extends EditorWorkerClient {
	private workerPromise: Promise<IWorkerClient<LanguageDetectionSimpleWorker>> | undefined;

	constructor(
		modelService: IModelService,
		private readonly _telemetryService: ITelemetryService,
		private readonly _indexJsUri: string,
		private readonly _modelJsonUri: string,
		private readonly _weightsUri: string,
		private readonly _regexpModelUri: string,
		languageConfigurationService: ILanguageConfigurationService,
	) {
		super(modelService, true, 'languageDetectionWorkerService', languageConfigurationService);
	}

	private _getOrCreateLanguageDetectionWorker(): Promise<IWorkerClient<LanguageDetectionSimpleWorker>> {
		if (this.workerPromise) {
			return this.workerPromise;
		}

		this.workerPromise = new Promise((resolve, reject) => {
			resolve(this._register(new SimpleWorkerClient<LanguageDetectionSimpleWorker, EditorWorkerHost>(
				this._workerFactory,
				'vs/workbench/services/languageDetection/browser/languageDetectionSimpleWorker',
				new EditorWorkerHost(this)
			)));
		});

		return this.workerPromise;
	}

	override async _getProxy(): Promise<LanguageDetectionSimpleWorker> {
		return (await this._getOrCreateLanguageDetectionWorker()).getProxyObject();
	}

	// foreign host request
	public override async fhr(method: string, args: any[]): Promise<any> {
		switch (method) {
			case 'getIndexJsUri':
				return this.getIndexJsUri();
			case 'getModelJsonUri':
				return this.getModelJsonUri();
			case 'getWeightsUri':
				return this.getWeightsUri();
			case 'getRegexpModelUri':
				return this.getRegexpModelUri();
			case 'sendTelemetryEvent':
				return this.sendTelemetryEvent(args[0], args[1], args[2]);
			default:
				return super.fhr(method, args);
		}
	}

	async getIndexJsUri() {
		return this._indexJsUri;
	}

	async getModelJsonUri() {
		return this._modelJsonUri;
	}

	async getWeightsUri() {
		return this._weightsUri;
	}

	async getRegexpModelUri() {
		return this._regexpModelUri;
	}

	async sendTelemetryEvent(languages: string[], confidences: number[], timeSpent: number): Promise<void> {
		this._telemetryService.publicLog2<ILanguageDetectionStats, LanguageDetectionStatsClassification>(LanguageDetectionStatsId, {
			languages: languages.join(','),
			confidences: confidences.join(','),
			timeSpent
		});
	}

	public async detectLanguage(resource: URI, langBiases?: Record<string, number>): Promise<string | undefined> {
		await this._withSyncedResources([resource]);
		return (await this._getProxy()).detectLanguage(resource.toString(), langBiases);
	}
}

registerSingleton(ILanguageDetectionService, LanguageDetectionService);
