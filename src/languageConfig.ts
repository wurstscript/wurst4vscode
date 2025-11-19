import { IndentAction, LanguageConfiguration } from "vscode";

export let languageConfig: LanguageConfiguration = {
    comments: {
        lineComment: '//',
        blockComment: ['/*', '*/'],
    },
    brackets: [
        ['<', '>'],
        ['[', ']'],
        ['(', ')'],
    ],
    onEnterRules: [
        {
            //                       < keywords behind which a space must follow >          <keywords without space>  <construct may have no spaces>
            beforeText:
                /^\s*(?:((if|while|for|function|class|module|enum|interface|case|switch)\b.*)|(begin|ondestroy|init)|(construct|else|elseif).*)|.*->\s*$/,
            action: { indentAction: IndentAction.Indent },
        },
        {
            beforeText: /^\s*(end|exitwhen|break|skip|return)(\s.*)?$/,
            action: { indentAction: IndentAction.Outdent },
        },
    ],
};
