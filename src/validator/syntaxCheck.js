// Runs every generated file through esbuild's parser. This catches malformed
// code (unclosed braces, stray tokens, broken JSX) that the regex-based
// validator can't see -- a file can match every path/method pattern it looks
// for and still fail to parse. Findings feed into the same Backend:/Frontend:
// retry loop as validateContract's mismatches.
import { transform } from 'esbuild';

export async function checkSyntax(files) {
  const issues = [];

  for (const [filename, content] of Object.entries(files)) {
    const loader = filename.endsWith('.jsx') ? 'jsx' : 'js';
    const side = filename.startsWith('src/') ? 'Frontend' : 'Backend';

    try {
      await transform(content, { loader, format: 'esm', target: 'es2020' });
    } catch (err) {
      const detail = err.errors?.[0]?.text || err.message;
      issues.push(`${side}: ${filename} failed to parse (${detail})`);
    }
  }

  return issues;
}
