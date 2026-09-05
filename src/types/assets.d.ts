/**
 * Stylesheets imported from host code are inlined as strings by webpack (`type: 'asset/source'`,
 * see webpack.config.js) and by the test loader (e2e/harness/tsLoader.js). Keeping viewer CSS in
 * real .css files keeps it out of the TypeScript modules and editable/lintable as CSS.
 */
declare module '*.css' {
    const css: string;
    export default css;
}
