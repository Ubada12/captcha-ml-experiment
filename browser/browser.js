/**
 * ============================================================
 * BROWSER MANAGER
 * ============================================================
 *
 * Owns the Puppeteer browser/page lifecycle: launch, page
 * creation, navigation, and cleanup. Nothing in here knows
 * about CAPTCHAs, GSTIN forms, or the taxpayer API — that
 * belongs to the captcha/ and taxpayer/ modules, which receive
 * the `page` object from main.js.
 */

const puppeteer = require("puppeteer");
const logger = require("../logger/logger");
const config = require("../config/config");

class BrowserManager {

    constructor() {
        this.browser = null;
        this.page = null;
    }

    async launch() {
        logger.info("Launching Chromium...");

        this.browser = await puppeteer.launch(
            config.browser.launchOptions
        );

        logger.success("Chromium launched successfully.");
        return this.browser;
    }

    async newPage() {
        if (!this.browser) {
            throw new Error(
                "[Browser] Cannot create a page: browser has not been launched yet."
            );
        }

        this.page = await this.browser.newPage();
        logger.debug("New page created.");
        return this.page;
    }

    async goto(url) {
        if (!this.page) {
            throw new Error(
                "[Browser] Cannot navigate: no page has been created yet."
            );
        }

        logger.info(`Navigating to ${url}`);

        await this.page.goto(url, {
            waitUntil: "networkidle2",
            timeout: config.timeouts.pageNavigationMs
        });

        logger.success("Target page loaded successfully.");
    }

    /**
     * Returns the most recently opened page, useful for failure
     * diagnostics if the page reference held elsewhere has
     * navigated away or a popup was spawned.
     */
    async getCurrentPage() {
        if (!this.browser) {
            return null;
        }

        const pages = await this.browser.pages();
        return pages[pages.length - 1] || null;
    }

    async close() {
        if (!this.browser) {
            return;
        }

        logger.info("Closing browser...");

        try {
            await this.browser.close();
            logger.success("Browser closed successfully.");
        } catch (error) {
            logger.error({ err: error }, "Failed to close browser cleanly.");
        } finally {
            this.browser = null;
            this.page = null;
        }
    }
}

module.exports = BrowserManager;
