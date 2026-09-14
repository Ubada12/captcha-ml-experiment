/**
 * ============================================================
 * MAIN — CLI ENTRY POINT
 * ============================================================
 *
 * One-shot command-line run of the lookup pipeline for the
 * single GSTIN configured in config/config.js (GSTIN_NUMBER in
 * .env, or the built-in default). For serving lookups on demand
 * for arbitrary GSTINs over HTTP, see server.js — both entry
 * points call the same pipeline/pipeline.js, so there is exactly
 * one implementation of the actual automation logic.
 */

require("dotenv").config();

const config = require("./config/config");
const logger = require("./logger/logger");
const { runLookup } = require("./pipeline/pipeline");

runLookup(config.gstin)
    .then(() => {
        logger.success("Workflow completed successfully.");
    })
    .catch(error => {
        logger.error({ err: error }, "Workflow terminated with error.");
        process.exitCode = 1;
    });
