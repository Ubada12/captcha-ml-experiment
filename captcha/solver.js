/**
 * ============================================================
 * 2CAPTCHA SOLVER
 * ============================================================
 *
 * Talks to the 2Captcha ImageToTextTask API: create a task,
 * then poll until it's ready. This is intentionally the ONLY
 * module that knows 2Captcha's HTTP contract — swapping in a
 * different solver, or a future own-trained model (see
 * storage/dataset-store.js and the roadmap in README.md), means
 * writing a new module with the same two exports and pointing
 * captcha logic at it, without touching capture.js or main.js.
 */

const axios = require("axios");
const logger = require("../logger/logger");
const config = require("../config/config");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function createCaptchaTask(base64Image) {

    logger.debug("Creating 2Captcha ImageToTextTask...");

    if (!base64Image) {
        throw new Error("[2Captcha] Cannot create task: CAPTCHA image is empty.");
    }

    try {

        const response = await axios.post(
            "https://api.2captcha.com/createTask",
            {
                clientKey: config.captchaSolver.apiKey,
                task: {
                    type: "ImageToTextTask",
                    body: base64Image,
                    numeric: 1,
                    minLength: config.captchaSolver.expectedLength,
                    maxLength: config.captchaSolver.expectedLength
                }
            },
            {
                timeout: config.timeouts.apiRequestMs
            }
        );

        const data = response.data;

        logger.debug(`2Captcha createTask response received. errorId=${data?.errorId}`);

        if (data?.errorId !== 0) {
            throw new Error(
                `[2Captcha] createTask failed: ${
                    data?.errorCode || data?.errorDescription || "Unknown API error"
                }`
            );
        }

        if (!data?.taskId) {
            throw new Error("[2Captcha] createTask succeeded but no taskId was returned.");
        }

        logger.success(`2Captcha task created. Task ID: ${data.taskId}`);
        return data.taskId;

    } catch (error) {

        if (error.response) {
            throw new Error(
                `[2Captcha] createTask HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
            );
        }

        throw new Error(`[2Captcha] createTask request failed: ${error.message}`);
    }
}

async function pollCaptchaResult(taskId) {

    logger.info(`Waiting for 2Captcha solution. Task ID: ${taskId}`);

    const { maxPollAttempts, pollIntervalMs } = config.captchaSolver;

    for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {

        await sleep(pollIntervalMs);

        logger.debug(`Polling 2Captcha result ${attempt}/${maxPollAttempts}...`);

        let response;

        try {

            response = await axios.post(
                "https://api.2captcha.com/getTaskResult",
                {
                    clientKey: config.captchaSolver.apiKey,
                    taskId
                },
                {
                    timeout: config.timeouts.apiRequestMs
                }
            );

        } catch (error) {

            if (error.response) {
                throw new Error(
                    `[2Captcha] getTaskResult HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
                );
            }

            throw new Error(`[2Captcha] getTaskResult request failed: ${error.message}`);
        }

        const data = response.data;

        if (data?.errorId !== 0) {
            throw new Error(
                `[2Captcha] getTaskResult failed: ${
                    data?.errorCode || data?.errorDescription || "Unknown API error"
                }`
            );
        }

        if (data?.status === "processing") {
            logger.debug("CAPTCHA still processing.");
            continue;
        }

        if (data?.status === "ready") {

            logger.success("2Captcha reports task as ready.");

            // Do not call .trim() directly on optional data.
            const rawSolution = data?.solution?.text;

            if (typeof rawSolution !== "string") {
                throw new Error(
                    "[2Captcha] Task is ready but solution.text is missing or is not a string."
                );
            }

            const solution = rawSolution.trim();

            logger.debug(
                `2Captcha solve completed. Cost: ${data?.cost ?? "unknown"}` +
                (data?.solveCount !== undefined ? `, solveCount: ${data.solveCount}` : "")
            );

            return {
                text: solution,
                cost: data?.cost ?? null,
                solveCount: data?.solveCount ?? null,
                taskId
            };
        }

        throw new Error(`[2Captcha] Unexpected task status: ${data?.status ?? "undefined"}`);
    }

    throw new Error(
        `[2Captcha] Timeout waiting for task ${taskId}. ` +
        `Maximum polling time was approximately ${(maxPollAttempts * pollIntervalMs) / 1000} seconds.`
    );
}

module.exports = { createCaptchaTask, pollCaptchaResult };
