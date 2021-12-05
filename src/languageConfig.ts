import { IndentAction, LanguageConfiguration } from "vscode";

export let languageConfig: LanguageConfiguration = {
    comments: {
        lineComment: '//',
        blockComment: ['/*', '*/'],
    },
    brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
    ],
    indentationRules: {
        increaseIndentPattern:
            //            < keywords behind which a space must follow >          <keywords without space>  <construct may have no spaces>
            /^\s*(((if|while|for|function|class|module|interface|case|switch)\s.*)|(begin|ondestroy|init)|(construct|else).*)|.*(->)$/,
        decreaseIndentPattern: /^\s*(else|end)\s.*$/,
    },
};