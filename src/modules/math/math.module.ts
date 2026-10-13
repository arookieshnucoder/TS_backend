import { Router } from "express";
import type { MathOcrProvider } from "./contracts.js";
import { normalizeMath } from "./normalize.js";
import { AppError } from "../../common/errors/app-error.js";
export function createMathModule(variant: string, ocr?: MathOcrProvider) {
    const router = Router();
    router.get("/capabilities", (_request, response) => response.json({ data: { role: "初中数学搜题与解题", variant, text: true, ocr: !!ocr, ocrPath: "/api/math/ocr" } }));
    router.post("/ocr", async (request, response) => {
        if (!ocr) throw new AppError(501, "MATH_OCR_NOT_CONFIGURED", "拍照识题接口已预留，尚未配置OCR供应商。请先输入完整文字题目。");
        const body = request.body;
        if (!body || !["image/jpeg", "image/png"].includes(body.mimeType) || typeof body.base64 !== "string" || body.base64.length > 900000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64))
            throw new AppError(400, "MATH_INVALID_IMAGE", "请输入有效的PNG/JPEG base64图片。");
        const bytes = Buffer.from(body.base64, "base64"), png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!(body.mimeType === "image/png" ? png : jpeg)) throw new AppError(400, "MATH_INVALID_IMAGE", "图片格式与内容不一致。");
        const abort = new AbortController();
        const disconnected = () => { if (!response.writableEnded) abort.abort(); };
        response.on("close", disconnected);
        try {
            const result = await ocr.recognize({ bytes, mimeType: body.mimeType, language: "zh-CN" }, AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]));
            if (!result.text?.trim() || !Array.isArray(result.warnings) || result.warnings.some(w => typeof w !== "string") || !Array.isArray(result.regions) || result.regions.some(r => typeof r.text !== "string" || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1))
                throw new AppError(502, "MATH_OCR_INVALID_RESULT", "OCR供应商返回无效结果。");
            response.json({ data: { ...result, normalized: normalizeMath(result.text), needsConfirmation: result.regions.length === 0 || result.regions.some(r => r.confidence < .9) || result.warnings.length > 0 } });
        } finally { response.off("close", disconnected); }
    });
    return router;
}
