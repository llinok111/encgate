# 测试语料来源与许可

全部语料取自 **microsoft/vscode-loc**（MIT License），为 VS Code 语言包的人工翻译文案，
仅做"同一体裁、不同语言"的编码探测对照用，不是本项目原创内容。

| 文件 | 来源 | 字节 | 行数 |
|---|---|---|---|
| zh-hans.txt | microsoft/vscode-loc (MIT) · vscode-language-pack-zh-hans | 65557 | 1161 |
| zh-hant.txt | microsoft/vscode-loc (MIT) · vscode-language-pack-zh-hant | 65553 | 1147 |
| ja.txt | microsoft/vscode-loc (MIT) · vscode-language-pack-ja | 65591 | 677 |
| ko.txt | microsoft/vscode-loc (MIT) · vscode-language-pack-ko | 65548 | 859 |

重新生成：`node gate/scripts/make-fixtures.mjs`（需要访问 api.github.com）。
原文许可：https://github.com/microsoft/vscode-loc/blob/main/LICENSE
