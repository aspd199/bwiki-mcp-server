import type { Tool } from '../runtime/tool.ts';
import { extensionPacks } from './extensions/index.ts';

import { getPage } from './get-page.ts';
import { getPages } from './get-pages.ts';
import { getPageHistory } from './get-page-history.ts';
import { getRecentChanges } from './get-recent-changes.ts';
import { searchPage } from './search-page.ts';
import { searchPageByPrefix } from './search-page-by-prefix.ts';
import { parseWikitext } from './parse-wikitext.ts';
import { comparePages } from './compare-pages.ts';
import { getFile } from './get-file.ts';
import { getFileData } from './get-file-data.ts';
import { getRevision } from './get-revision.ts';
import { getSiteInfo } from './get-site-info.ts';
import { getCategoryMembers } from './get-category-members.ts';
import { getLinksHere } from './get-links-here.ts';
import { listWikis } from './list-wikis.ts';
import { whoami } from './whoami.ts';
import { createPage } from './create-page.ts';
import { updatePage } from './update-page.ts';
import { movePage } from './move-page.ts';
import { deletePage } from './delete-page.ts';
import { undeletePage } from './undelete-page.ts';
import { protectPage } from './protect-page.ts';
import { uploadFile } from './upload-file.ts';
import { uploadFileFromUrl } from './upload-file-from-url.ts';
import { updateFile } from './update-file.ts';
import { updateFileFromUrl } from './update-file-from-url.ts';
import { bwikiLogin } from './bwiki-login.ts';
import { bwikiLogout } from './bwiki-logout.ts';

// 所有需要 ToolContext 的工具：核心工具与各扩展包的工具。
// registerAllTools 与只读校验都读这份列表，二者不会不一致。
//
// `Tool<any>` 用于放宽异构 schema 数组：`inputSchema: TSchema` 在 TSchema 上不变，
// 故 `Tool<never>` 与 `Tool<ZodRawShape>` 都无法直接赋值。
//
// oxlint-disable-next-line typescript/no-explicit-any
export const standardTools: Tool<any>[] = [
	getPage,
	getPages,
	getPageHistory,
	getRecentChanges,
	searchPage,
	searchPageByPrefix,
	parseWikitext,
	comparePages,
	getFile,
	getFileData,
	getRevision,
	getSiteInfo,
	getCategoryMembers,
	getLinksHere,
	listWikis,
	whoami,
	createPage,
	updatePage,
	movePage,
	deletePage,
	undeletePage,
	protectPage,
	uploadFile,
	uploadFileFromUrl,
	updateFile,
	updateFileFromUrl,
	bwikiLogin,
	bwikiLogout,
	...extensionPacks.flatMap((pack) => pack.tools),
];
