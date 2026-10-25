PDF engine: PDFMathTranslate, https://github.com/PDFMathTranslate/PDFMathTranslate
Pinned revision: fe3d2f37ef1b54abff5ebda091a7fd4fac9fbd08 (1.9.12).
Copyright belongs to the upstream contributors. Licensed under AGPL-3.0-only; see LICENSE.
The modified upstream converter is tools/pdfmath_converter.py. Changes add an Agent translation bridge,
bounded paragraph scaling, white background / black text, and removal of unbounded translator retries.
The rest of the engine is installed from pinned, publicly available upstream source into an isolated environment.
Source for this integration is distributed with this application and in its Git repository.
