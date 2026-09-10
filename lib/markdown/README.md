# Vendored Markdown runtime

这些文件随应用本地分发，运行时不访问 CDN。

| 文件 | 上游版本 | 官方包路径 | SHA-256 |
|---|---:|---|---|
| `markdown-it.min.js` | 15.0.0 | `markdown-it/dist/browser/markdown-it.umd.min.js` | `8D0F6ACA8F4DE3321B6D07E03286176C59EC19B7B84ABB6EB31F0FA795E83ABC` |
| `markdown-it-footnote.min.js` | 4.0.0 | `markdown-it-footnote/dist/markdown-it-footnote.min.js` | `D6FEE58A3B56C5742FA18F3E01F1D317CC99975683EBD39C9195CB2AFF0C2E42` |
| `purify.min.js` | 3.4.12 | `dompurify/dist/purify.min.js` | `C45BA939765574F96CBF35EE9B6D89F73756A17921814425E74B82F7C54603CE` |
| `highlight.min.js` | 11.12.0 | `@highlightjs/cdn-assets/highlight.min.js` | `8AB71EB09C51F501E5E25157D9CFF100E46CC29BCBFC744D0B746D451FCA7F53` |
| `highlight-github-dark-dimmed.min.css` | 11.12.0 | `@highlightjs/cdn-assets/styles/github-dark-dimmed.min.css` | `BC1116BFBA58EE83794D53B8BD08E5AB13CBA81BF03454CF67D6CFE435033CAE` |

许可证原文保存在同目录的 `LICENSE.*.txt`。升级文件时必须同步更新本表、运行 Markdown/XSS 测试，并递增 `index.html` 与 Service Worker 的资源版本。
