import type { Logger } from './logger.ts';
import type { ToolContext } from './context.ts';
import type { AppState } from '../wikis/state.ts';
import { WikiCacheImpl } from '../wikis/wikiCache.ts';
import { SectionServiceImpl } from '../services/sectionService.ts';
import { EditServiceImpl } from '../services/editService.ts';
import { RevisionNormalizerImpl } from '../services/revisionNormalize.ts';
import { ResponseFormatterImpl } from '../results/response.ts';
import { ErrorClassifierImpl } from '../errors/classifyError.ts';
import { extensionErrorVocabulary, extensionPacks } from '../tools/extensions/index.ts';
import { withCallBounds } from '../wikis/abortableMwn.ts';
import { getRequestDeadline, getRequestSignal } from './requestContext.ts';
import { callDeadline, WIKI_CALL_TIMEOUT_MS } from './callDeadline.ts';

export function createToolContext(deps: {
	logger: Logger;
	state: AppState;
	transport: 'http' | 'stdio';
}): ToolContext {
	const { logger, state, transport } = deps;
	return {
		// 缓存实例是共享的，故只在每请求视图上加约束而非改实例本身。
		// 预算取自请求作用域，使多次获取站点仍共用一份预算。
		mwn: async (wikiKey?: string) => {
			const bot = await state.mwnProvider.get(wikiKey);
			const deadline = getRequestDeadline() ?? callDeadline(WIKI_CALL_TIMEOUT_MS, 'calling');
			return withCallBounds(bot, deadline, getRequestSignal());
		},
		wikis: state.wikiRegistry,
		activeWiki: state.activeWiki,
		uploadDirs: state.uploadDirs,
		wikiCache: new WikiCacheImpl(state.mwnProvider, state.siteInfoCache, state.wikiProbe),
		siteInfoCache: state.siteInfoCache,
		wikiProbe: state.wikiProbe,
		loginGate: state.loginGate,
		sections: new SectionServiceImpl(),
		edit: new EditServiceImpl(state.activeWiki),
		revision: new RevisionNormalizerImpl(),
		format: new ResponseFormatterImpl(),
		errors: new ErrorClassifierImpl(extensionErrorVocabulary(extensionPacks)),
		logger,
		transport,
	};
}
