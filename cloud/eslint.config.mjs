import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores:['node_modules/**','dist/**','dist-*.mjs'] },
  js.configs.recommended,
  { languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{...globals.node,__SUPABASE_CA__:'readonly'}},rules:{'no-unused-vars':['error',{argsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}]} },
  { files:['public/*.js'],languageOptions:{globals:globals.browser} },
];
