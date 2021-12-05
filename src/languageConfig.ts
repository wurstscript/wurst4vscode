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
    onEnterRules: [
        {
            //                       < keywords behind which a space must follow >          <keywords without space>  <construct may have no spaces>
            beforeText: /^\s*(((if|while|for|function|class|module|enum|interface|case|switch)\s.*)|(begin|ondestroy|init)|(construct|else).*)|.*(->)$/,
            action: {
                indentAction: IndentAction.Indent,
            },
        },
        {
            beforeText: /^\s*(else|end|exitwhen|break|skip|return)(\s.*)?$/,
            action: {
                indentAction: IndentAction.Outdent,
            },
        }
    ]
};