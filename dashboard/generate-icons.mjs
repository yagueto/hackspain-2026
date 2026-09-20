import { readFile, writeFile, copyFile } from 'node:fs/promises';

const names = JSON.parse(
  await readFile(new URL('src/app/shared/icon/icon-names.json', import.meta.url), 'utf8'),
);
const symbols = await Promise.all(
  [...new Set(Object.values(names))].map(async (name) => {
    const source = await readFile(
      new URL(`node_modules/@tabler/icons/icons/outline/${name}.svg`, import.meta.url),
      'utf8',
    );
    const content = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    return `<symbol id="${name}" viewBox="0 0 24 24">${content}</symbol>`;
  }),
);
await writeFile(
  new URL('public/tabler-icons.svg', import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join('\n')}\n</svg>\n`,
);
await copyFile(
  new URL('node_modules/@tabler/icons/LICENSE', import.meta.url),
  new URL('public/tabler-icons.LICENSE', import.meta.url),
);
await copyFile(
  new URL('node_modules/@fontsource-variable/inter/LICENSE', import.meta.url),
  new URL('public/inter.LICENSE', import.meta.url),
);
