import { build, Plugin } from 'esbuild';
import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { globSync } from 'glob';
import stripJsonComments from 'strip-json-comments';
import cac from 'cac';
import { createMatchPath } from 'tsconfig-paths';

const tsconfigPathsPlugin = (options: { tsconfigPath: string }): Plugin => {
  return {
    name: 'tsconfig-paths',
    setup(pluginBuild) {
      const { tsconfigPath } = options;
      const tsconfigDir = path.dirname(tsconfigPath);

      let tsconfigData: string;
      try {
        tsconfigData = readFileSync(tsconfigPath, 'utf8');
      } catch (err) {
        console.error(`Failed to read tsconfig file at: ${tsconfigPath}`);
        return;
      }
      
      const { compilerOptions } = JSON.parse(stripJsonComments(tsconfigData));

      if (!compilerOptions.paths) {
        return; // No paths to resolve
      }
      
      const resolvedBase = path.resolve(tsconfigDir, compilerOptions.baseUrl || '.');
      const pathKeys = Object.keys(compilerOptions.paths);
      const filter = new RegExp(`^(${pathKeys.map(key => key.replace('*', '.*')).join('|')})`);
      const match = createMatchPath(resolvedBase, compilerOptions.paths);

      pluginBuild.onResolve({ filter }, (args) => {
        const resolved = match(args.path, undefined, undefined, ['.ts', '.tsx', '.js', '.jsx', '.json']);
        if (resolved) {
          // If tsconfig-paths resolves a path, but it doesn't have an extension,
          // we need to manually check for it.
          if (!path.extname(resolved)) {
            const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
            for (const ext of extensions) {
              const filePath = `${resolved}${ext}`;
              try {
                if (existsSync(filePath) && statSync(filePath).isFile()) {
                  return { path: filePath };
                }
              } catch (e) {
                // Ignore errors from statSync, like for broken symlinks
              }
            }
            // Also check for index file if it's a directory
            for (const ext of extensions) {
              const filePath = `${resolved}/index${ext}`;
              try {
                if (existsSync(filePath) && statSync(filePath).isFile()) {
                  return { path: filePath };
                }
              } catch (e) {
                // Ignore errors from statSync
              }
            }
          } else {
            // If it already has an extension, just return it
            return { path: resolved };
          }
        }
        return undefined;
      });
    },
  };
};

async function runBuild(options: { project: string }) {
  try {
    const tsconfigPath = path.resolve(process.cwd(), options.project);
    const tsconfigDir = path.dirname(tsconfigPath);
    const tsconfigRaw = readFileSync(tsconfigPath, 'utf8');
    const tsconfig = JSON.parse(stripJsonComments(tsconfigRaw));

    const { compilerOptions, include, exclude, files } = tsconfig;

    let entryPoints: string[] = [];
    if (files) {
      entryPoints = files.map((file: string) => path.resolve(tsconfigDir, file));
    } else if (include && Array.isArray(include)) {
      entryPoints = globSync(include, {
        cwd: tsconfigDir,
        ignore: exclude,
        absolute: true,
      });

      // If bundling, esbuild expects a single entry point.
      // If multiple entry points are found by glob, we should pick the primary one.
      // For simplicity, we'll take the first one for now.
      if (entryPoints.length > 1) {
        // Find the main entry point if possible, e.g., 'main.ts' or 'index.ts'
        const mainEntry = entryPoints.find(ep => ep.endsWith('main.ts') || ep.endsWith('index.ts'));
        if (mainEntry) {
          entryPoints = [mainEntry];
        } else {
          entryPoints = [entryPoints[0]];
        }
      }
    }

    if (entryPoints.length === 0) {
      console.error('No entry points found. Please check your tsconfig.json "files" or "include" fields.');
      process.exit(1);
    }

    const outdir = compilerOptions?.outDir
      ? path.resolve(tsconfigDir, compilerOptions.outDir)
      : path.join(tsconfigDir, 'dist');

    await build({
      entryPoints,
      outdir,
      target: compilerOptions?.target?.toLowerCase(),
      sourcemap: compilerOptions?.sourceMap,
      jsx: compilerOptions?.jsx,
      jsxFactory: compilerOptions?.jsxFactory,
      jsxFragment: compilerOptions?.jsxFragmentFactory,
      bundle: true,
      platform: 'node',
      absWorkingDir: tsconfigDir,
      plugins: [tsconfigPathsPlugin({ tsconfigPath })],
    });

    console.log('✨ Build finished successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

const cli = cac('@hirarijs/builder');

cli
  .command('', 'Run the build')
  .option('-p, --project <path>', 'Path to the tsconfig.json file', {
    default: 'tsconfig.json',
  })
  .action(runBuild);

cli.help();
cli.version('0.1.0');

cli.parse();
