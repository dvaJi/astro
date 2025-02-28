import * as eslexer from 'es-module-lexer';
import glob from 'fast-glob';
import fs from 'fs';
import { bgGreen, bgMagenta, black, dim } from 'kleur/colors';
import { fileURLToPath } from 'url';
import * as vite from 'vite';
import { astroBundleDelayedAssetPlugin } from '../../content/index.js';
import {
	BuildInternals,
	createBuildInternals,
	eachPrerenderedPageData,
} from '../../core/build/internal.js';
import { emptyDir, removeEmptyDirs } from '../../core/fs/index.js';
import { appendForwardSlash, prependForwardSlash } from '../../core/path.js';
import { isModeServerWithNoAdapter } from '../../core/util.js';
import { runHookBuildSetup } from '../../integrations/index.js';
import { PAGE_SCRIPT_ID } from '../../vite-plugin-scripts/index.js';
import { AstroError, AstroErrorData } from '../errors/index.js';
import { info } from '../logger/core.js';
import { getOutDirWithinCwd } from './common.js';
import { generatePages } from './generate.js';
import { trackPageData } from './internal.js';
import type { PageBuildData, StaticBuildOptions } from './types';
import { getTimeStat } from './util.js';
import { vitePluginAliasResolve } from './vite-plugin-alias-resolve.js';
import { vitePluginAnalyzer } from './vite-plugin-analyzer.js';
import { rollupPluginAstroBuildCSS } from './vite-plugin-css.js';
import { vitePluginHoistedScripts } from './vite-plugin-hoisted-scripts.js';
import { vitePluginInternals } from './vite-plugin-internals.js';
import { vitePluginPages } from './vite-plugin-pages.js';
import { vitePluginPrerender } from './vite-plugin-prerender.js';
import { injectManifest, vitePluginSSR } from './vite-plugin-ssr.js';

export async function staticBuild(opts: StaticBuildOptions) {
	const { allPages, settings } = opts;

	// Make sure we have an adapter before building
	if (isModeServerWithNoAdapter(opts.settings)) {
		throw new AstroError(AstroErrorData.NoAdapterInstalled);
	}

	// The pages to be built for rendering purposes.
	const pageInput = new Set<string>();

	// A map of each page .astro file, to the PageBuildData which contains information
	// about that page, such as its paths.
	const facadeIdToPageDataMap = new Map<string, PageBuildData>();

	// Build internals needed by the CSS plugin
	const internals = createBuildInternals();

	const timer: Record<string, number> = {};

	timer.buildStart = performance.now();

	for (const [component, pageData] of Object.entries(allPages)) {
		const astroModuleURL = new URL('./' + component, settings.config.root);
		const astroModuleId = prependForwardSlash(component);

		// Track the page data in internals
		trackPageData(internals, component, pageData, astroModuleId, astroModuleURL);

		pageInput.add(astroModuleId);
		facadeIdToPageDataMap.set(fileURLToPath(astroModuleURL), pageData);
	}

	// Empty out the dist folder, if needed. Vite has a config for doing this
	// but because we are running 2 vite builds in parallel, that would cause a race
	// condition, so we are doing it ourselves
	emptyDir(settings.config.outDir, new Set('.git'));

	// Build your project (SSR application code, assets, client JS, etc.)
	timer.ssr = performance.now();
	info(opts.logging, 'build', `Building ${settings.config.output} entrypoints...`);
	await ssrBuild(opts, internals, pageInput);
	info(opts.logging, 'build', dim(`Completed in ${getTimeStat(timer.ssr, performance.now())}.`));

	const rendererClientEntrypoints = settings.renderers
		.map((r) => r.clientEntrypoint)
		.filter((a) => typeof a === 'string') as string[];

	const clientInput = new Set([
		...internals.discoveredHydratedComponents,
		...internals.discoveredClientOnlyComponents,
		...rendererClientEntrypoints,
		...internals.discoveredScripts,
	]);

	if (settings.scripts.some((script) => script.stage === 'page')) {
		clientInput.add(PAGE_SCRIPT_ID);
	}

	// Run client build first, so the assets can be fed into the SSR rendered version.
	timer.clientBuild = performance.now();
	await clientBuild(opts, internals, clientInput);

	timer.generate = performance.now();
	switch (settings.config.output) {
		case 'static': {
			await generatePages(opts, internals);
			await cleanServerOutput(opts);
			return;
		}
		case 'server': {
			await injectManifest(opts, internals);
			await generatePages(opts, internals);
			await cleanStaticOutput(opts, internals);
			info(opts.logging, null, `\n${bgMagenta(black(' finalizing server assets '))}\n`);
			await ssrMoveAssets(opts);
			return;
		}
	}
}

async function ssrBuild(opts: StaticBuildOptions, internals: BuildInternals, input: Set<string>) {
	const { settings, viteConfig } = opts;
	const ssr = settings.config.output === 'server';
	const out = ssr ? opts.buildConfig.server : getOutDirWithinCwd(settings.config.outDir);

	const viteBuildConfig: vite.InlineConfig = {
		...viteConfig,
		mode: viteConfig.mode || 'production',
		logLevel: opts.viteConfig.logLevel ?? 'error',
		build: {
			target: 'esnext',
			...viteConfig.build,
			emptyOutDir: false,
			manifest: false,
			outDir: fileURLToPath(out),
			copyPublicDir: !ssr,
			rollupOptions: {
				...viteConfig.build?.rollupOptions,
				input: [],
				output: {
					format: 'esm',
					// Server chunks can't go in the assets (_astro) folder
					// We need to keep these separate
					chunkFileNames: `chunks/[name].[hash].mjs`,
					assetFileNames: `${settings.config.build.assets}/[name].[hash][extname]`,
					...viteConfig.build?.rollupOptions?.output,
					entryFileNames: opts.buildConfig.serverEntry,
				},
			},
			ssr: true,
			// improve build performance
			minify: false,
			modulePreload: { polyfill: false },
			reportCompressedSize: false,
		},
		plugins: [
			vitePluginAnalyzer(internals),
			vitePluginInternals(input, internals),
			vitePluginPages(opts, internals),
			rollupPluginAstroBuildCSS({
				buildOptions: opts,
				internals,
				target: 'server',
			}),
			vitePluginPrerender(opts, internals),
			...(viteConfig.plugins || []),
			astroBundleDelayedAssetPlugin({ internals }),
			// SSR needs to be last
			ssr && vitePluginSSR(internals, settings.adapter!),
		],
		envPrefix: viteConfig.envPrefix ?? 'PUBLIC_',
		base: settings.config.base,
	};

	await runHookBuildSetup({
		config: settings.config,
		pages: internals.pagesByComponent,
		vite: viteBuildConfig,
		target: 'server',
		logging: opts.logging,
	});

	return await vite.build(viteBuildConfig);
}

async function clientBuild(
	opts: StaticBuildOptions,
	internals: BuildInternals,
	input: Set<string>
) {
	const { settings, viteConfig } = opts;
	const timer = performance.now();
	const ssr = settings.config.output === 'server';
	const out = ssr ? opts.buildConfig.client : getOutDirWithinCwd(settings.config.outDir);

	// Nothing to do if there is no client-side JS.
	if (!input.size) {
		// If SSR, copy public over
		if (ssr) {
			await copyFiles(settings.config.publicDir, out, true);
		}

		return null;
	}

	info(opts.logging, null, `\n${bgGreen(black(' building client '))}`);

	const viteBuildConfig: vite.InlineConfig = {
		...viteConfig,
		mode: viteConfig.mode || 'production',
		logLevel: 'info',
		build: {
			target: 'esnext',
			...viteConfig.build,
			emptyOutDir: false,
			outDir: fileURLToPath(out),
			rollupOptions: {
				...viteConfig.build?.rollupOptions,
				input: Array.from(input),
				output: {
					format: 'esm',
					entryFileNames: `${settings.config.build.assets}/[name].[hash].js`,
					chunkFileNames: `${settings.config.build.assets}/[name].[hash].js`,
					assetFileNames: `${settings.config.build.assets}/[name].[hash][extname]`,
					...viteConfig.build?.rollupOptions?.output,
				},
				preserveEntrySignatures: 'exports-only',
			},
		},
		plugins: [
			vitePluginAliasResolve(internals),
			vitePluginInternals(input, internals),
			vitePluginHoistedScripts(settings, internals),
			rollupPluginAstroBuildCSS({
				buildOptions: opts,
				internals,
				target: 'client',
			}),
			...(viteConfig.plugins || []),
		],
		envPrefix: viteConfig.envPrefix ?? 'PUBLIC_',
		base: settings.config.base,
	};

	await runHookBuildSetup({
		config: settings.config,
		pages: internals.pagesByComponent,
		vite: viteBuildConfig,
		target: 'client',
		logging: opts.logging,
	});

	const buildResult = await vite.build(viteBuildConfig);
	info(opts.logging, null, dim(`Completed in ${getTimeStat(timer, performance.now())}.\n`));
	return buildResult;
}

/**
 * For each statically prerendered page, replace their SSR file with a noop.
 * This allows us to run the SSR build only once, but still remove dependencies for statically rendered routes.
 */
async function cleanStaticOutput(opts: StaticBuildOptions, internals: BuildInternals) {
	const allStaticFiles = new Set();
	for (const pageData of eachPrerenderedPageData(internals)) {
		allStaticFiles.add(internals.pageToBundleMap.get(pageData.moduleSpecifier));
	}
	const ssr = opts.settings.config.output === 'server';
	const out = ssr ? opts.buildConfig.server : getOutDirWithinCwd(opts.settings.config.outDir);
	// The SSR output is all .mjs files, the client output is not.
	const files = await glob('**/*.mjs', {
		cwd: fileURLToPath(out),
	});

	if (files.length) {
		await eslexer.init;

		// Cleanup prerendered chunks.
		// This has to happen AFTER the SSR build runs as a final step, because we need the code in order to generate the pages.
		// These chunks should only contain prerendering logic, so they are safe to modify.
		await Promise.all(
			files.map(async (filename) => {
				if (!allStaticFiles.has(filename)) {
					return;
				}
				const url = new URL(filename, out);
				const text = await fs.promises.readFile(url, { encoding: 'utf8' });
				const [, exports] = eslexer.parse(text);
				// Replace exports (only prerendered pages) with a noop
				let value = 'const noop = () => {};';
				for (const e of exports) {
					value += `\nexport const ${e.n} = noop;`;
				}
				await fs.promises.writeFile(url, value, { encoding: 'utf8' });
			})
		);

		removeEmptyDirs(out);
	}
}

async function cleanServerOutput(opts: StaticBuildOptions) {
	const out = getOutDirWithinCwd(opts.settings.config.outDir);
	// The SSR output is all .mjs files, the client output is not.
	const files = await glob('**/*.mjs', {
		cwd: fileURLToPath(out),
	});
	if (files.length) {
		// Remove all the SSR generated .mjs files
		await Promise.all(
			files.map(async (filename) => {
				const url = new URL(filename, out);
				await fs.promises.rm(url);
			})
		);

		removeEmptyDirs(out);
	}

	// Clean out directly if the outDir is outside of root
	if (out.toString() !== opts.settings.config.outDir.toString()) {
		// Copy assets before cleaning directory if outside root
		copyFiles(out, opts.settings.config.outDir);
		await fs.promises.rm(out, { recursive: true });
		return;
	}
}

async function copyFiles(fromFolder: URL, toFolder: URL, includeDotfiles = false) {
	const files = await glob('**/*', {
		cwd: fileURLToPath(fromFolder),
		dot: includeDotfiles,
	});

	await Promise.all(
		files.map(async (filename) => {
			const from = new URL(filename, fromFolder);
			const to = new URL(filename, toFolder);
			const lastFolder = new URL('./', to);
			return fs.promises
				.mkdir(lastFolder, { recursive: true })
				.then(() => fs.promises.copyFile(from, to));
		})
	);
}

async function ssrMoveAssets(opts: StaticBuildOptions) {
	info(opts.logging, 'build', 'Rearranging server assets...');
	const serverRoot =
		opts.settings.config.output === 'static' ? opts.buildConfig.client : opts.buildConfig.server;
	const clientRoot = opts.buildConfig.client;
	const assets = opts.settings.config.build.assets;
	const serverAssets = new URL(`./${assets}/`, appendForwardSlash(serverRoot.toString()));
	const clientAssets = new URL(`./${assets}/`, appendForwardSlash(clientRoot.toString()));
	const files = await glob(`**/*`, {
		cwd: fileURLToPath(serverAssets),
	});

	if (files.length > 0) {
		// Make the directory
		await fs.promises.mkdir(clientAssets, { recursive: true });
		await Promise.all(
			files.map(async (filename) => {
				const currentUrl = new URL(filename, appendForwardSlash(serverAssets.toString()));
				const clientUrl = new URL(filename, appendForwardSlash(clientAssets.toString()));
				return fs.promises.rename(currentUrl, clientUrl);
			})
		);
		removeEmptyDirs(serverAssets);
	}
}
