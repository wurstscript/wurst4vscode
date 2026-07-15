import { IndentAction, LanguageConfiguration } from "vscode";

export const languageConfig = {
    comments: {
        lineComment: '//',
        blockComment: ['/*', '*/'],
    },
    brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
    ],
    surroundingPairs: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
        ['"', '"'],
        ["'", "'"],
        ['<', '>'],
    ],
    colorizedBracketPairs: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
    ],
    onEnterRules: [
        {
            //                       < keywords behind which a space must follow >          <keywords without space>  <construct may have no spaces>
            beforeText:
                // eslint-disable-next-line sonarjs/super-linear-regex, sonarjs/regex-complexity -- TODO(lint-cleanup): drives live editor auto-indent on every Enter keypress and has no test coverage; rewriting it needs its own careful, tested pass rather than a rushed change here.
                /^\s*(?:((if|while|for|function|class|module|enum|interface|case|switch)\b.*)|(begin|ondestroy|init)|(construct|else|elseif).*)|.*->\s*$/,
            action: { indentAction: IndentAction.Indent },
        },
        {
            beforeText: /^\s*(end|exitwhen|break|continue|skip|return)(\s.*)?$/,
            action: { indentAction: IndentAction.Outdent },
        },
    ],
} as LanguageConfiguration & { colorizedBracketPairs: [string, string][] };
