require("dotenv").config();

const puppeteer = require("puppeteer");

// ============================================================
// CONFIGURATION
// ============================================================

const TARGET_URL = "https://cleartax.in/gst-number-search/";
const GSTIN_NUMBER = "27AOHPA6448R1ZC";

// From the page shown in DevTools.
// Keep this broad for the first test; once we confirm the exact
// request, we can make this pattern more specific.
const TARGET_REQUEST_PATTERN = "/compliance-report/";

// Input shown in the page:
// placeholder="Enter company name or GSTIN"
const GSTIN_INPUT_SELECTOR =
  'input[placeholder="Enter company name or GSTIN"]';

// Search button shown in the page.
const SEARCH_BUTTON_SELECTOR = 'button';

// Timeouts
const PAGE_LOAD_TIMEOUT_MS = 30000;
const ELEMENT_TIMEOUT_MS = 15000;
const RESPONSE_TIMEOUT_MS = 30000;


// ============================================================
// LOGGER
// ============================================================

function timestamp() {
  return new Date().toISOString();
}

function log(level, message, ...args) {
  console.log(`[${timestamp()}] [${level}] ${message}`, ...args);
}

function info(message, ...args) {
  log("INFO", message, ...args);
}

function debug(message, ...args) {
  log("DEBUG", message, ...args);
}

function success(message, ...args) {
  log("SUCCESS", message, ...args);
}

function warn(message, ...args) {
  log("WARN", message, ...args);
}

function error(message, ...args) {
  log("ERROR", message, ...args);
}


// ============================================================
// FIND SEARCH BUTTON
// ============================================================

async function findSearchButton(page) {
  debug("Searching for SEARCH button...");

  const buttons = await page.$$("button");

  for (const button of buttons) {
    const text = await button.evaluate(element =>
      element.textContent?.trim().toUpperCase()
    );

    if (text === "SEARCH") {
      debug("SEARCH button found.");
      return button;
    }
  }

  throw new Error("SEARCH button could not be found.");
}


// ============================================================
// WAIT FOR TARGET NETWORK RESPONSE
// ============================================================

function waitForTargetResponse(page) {
  debug(
    `Installing network listener for requests containing: "${TARGET_REQUEST_PATTERN}"`
  );

  return page.waitForResponse(
    async response => {
      const url = response.url();

      if (!url.includes(TARGET_REQUEST_PATTERN)) {
        return false;
      }

      debug("Matching network request detected.");
      debug(`Request URL: ${url}`);
      debug(`HTTP method: ${response.request().method()}`);
      debug(`HTTP status: ${response.status()}`);
      debug(`Resource type: ${response.request().resourceType()}`);

      return true;
    },
    {
      timeout: RESPONSE_TIMEOUT_MS
    }
  );
}


// ============================================================
// MAIN SCRAPER
// ============================================================

async function runScraper() {
  let browser = null;

  console.log("");
  console.log("============================================================");
  console.log("        GST SEARCH NETWORK INTERCEPTION TEST");
  console.log("============================================================");
  console.log("");

  try {
    // ----------------------------------------------------------
    // 1. Launch browser
    // ----------------------------------------------------------

    info("Launching Chromium...");

    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: [
        "--start-maximized"
      ]
    });

    success("Chromium launched successfully.");

    // ----------------------------------------------------------
    // 2. Create page
    // ----------------------------------------------------------

    const page = await browser.newPage();

    info("New browser page created.");

    // Helpful browser logging
    page.on("console", message => {
      debug(`[PAGE CONSOLE] ${message.type()}: ${message.text()}`);
    });

    page.on("pageerror", pageError => {
      warn(`[PAGE ERROR] ${pageError.message}`);
    });

    // ----------------------------------------------------------
    // 3. Open website
    // ----------------------------------------------------------

    info(`Opening: ${TARGET_URL}`);

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS
    });

    success("Page loaded.");
    debug(`Current URL: ${page.url()}`);

    // ----------------------------------------------------------
    // 4. Wait for GSTIN input
    // ----------------------------------------------------------

    info("Waiting for GSTIN input...");

    await page.waitForSelector(GSTIN_INPUT_SELECTOR, {
      visible: true,
      timeout: ELEMENT_TIMEOUT_MS
    });

    success("GSTIN input found.");

    // ----------------------------------------------------------
    // 5. Enter GSTIN
    // ----------------------------------------------------------

    info(`Entering GSTIN: ${GSTIN_NUMBER}`);

    await page.click(GSTIN_INPUT_SELECTOR);

    // Clear anything already present
    await page.evaluate(selector => {
      const input = document.querySelector(selector);

      if (input) {
        input.value = "";
        input.dispatchEvent(
          new Event("input", {
            bubbles: true
          })
        );
      }
    }, GSTIN_INPUT_SELECTOR);

    await page.type(GSTIN_INPUT_SELECTOR, GSTIN_NUMBER, {
      delay: 80
    });

    success("GSTIN entered successfully.");

    // ----------------------------------------------------------
    // 6. Find SEARCH button
    // ----------------------------------------------------------

    const searchButton = await findSearchButton(page);

    // ----------------------------------------------------------
    // 7. IMPORTANT:
    //    Start listening BEFORE clicking Search
    // ----------------------------------------------------------

    info("Preparing network response listener...");

    const targetResponsePromise = waitForTargetResponse(page);

    // ----------------------------------------------------------
    // 8. Click SEARCH
    // ----------------------------------------------------------

    info("Clicking SEARCH...");

    await searchButton.click();

    success("SEARCH button clicked.");

    // ----------------------------------------------------------
    // 9. Wait for network response
    // ----------------------------------------------------------

    info("Waiting for target network response...");

    let targetResponse;

    try {
      targetResponse = await targetResponsePromise;
    } catch (err) {
      throw new Error(
        `Target network response was not detected within ${
          RESPONSE_TIMEOUT_MS / 1000
        } seconds.`
      );
    }

    // ----------------------------------------------------------
    // 10. Response information
    // ----------------------------------------------------------

    console.log("");
    console.log("============================================================");
    console.log("              TARGET REQUEST DETECTED");
    console.log("============================================================");

    console.log("URL:");
    console.log(targetResponse.url());

    console.log("");

    console.log("METHOD:");
    console.log(targetResponse.request().method());

    console.log("");

    console.log("STATUS:");
    console.log(targetResponse.status());

    console.log("");

    console.log("RESOURCE TYPE:");
    console.log(targetResponse.request().resourceType());

    console.log("");

    // ----------------------------------------------------------
    // 11. Read response
    // ----------------------------------------------------------

    info("Reading response body...");

    const contentType =
      targetResponse.headers()["content-type"] || "";

    debug(`Content-Type: ${contentType}`);

    let responseData;

    if (contentType.includes("application/json")) {
      responseData = await targetResponse.json();

      success("Response parsed as JSON.");
    } else {
      const responseText = await targetResponse.text();

      warn(
        "Response does not appear to be JSON. Returning raw response text."
      );

      responseData = responseText;
    }

    // ----------------------------------------------------------
    // 12. Display result
    // ----------------------------------------------------------

    console.log("");
    console.log("============================================================");
    console.log("                 RESPONSE DATA");
    console.log("============================================================");

    if (typeof responseData === "string") {
      console.log(responseData);
    } else {
      console.log(JSON.stringify(responseData, null, 2));
    }

    console.log("");
    console.log("============================================================");
    console.log("                  TEST COMPLETE");
    console.log("============================================================");
    console.log("");

    success("Network interception test completed successfully.");

    return responseData;

  } catch (err) {

    // ----------------------------------------------------------
    // Error handling
    // ----------------------------------------------------------

    error("Scraper failed.");
    error(err.message);

    if (browser) {
      try {
        const pages = await browser.pages();
        const currentPage = pages[pages.length - 1];

        if (currentPage) {
          warn(`Current URL: ${currentPage.url()}`);

          const screenshotPath =
            `failure-${Date.now()}.png`;

          await currentPage.screenshot({
            path: screenshotPath,
            fullPage: true
          });

          debug(
            `Failure screenshot saved: ${screenshotPath}`
          );
        }
      } catch (debugError) {
        error(
          `Could not capture failure diagnostics: ${debugError.message}`
        );
      }
    }

    throw err;

  } finally {

    // ----------------------------------------------------------
    // Browser cleanup
    // ----------------------------------------------------------

    if (browser) {
      info("Closing Chromium...");

      try {
        await browser.close();
        success("Browser closed.");
      } catch (closeError) {
        error(
          `Failed to close browser cleanly: ${closeError.message}`
        );
      }
    }
  }
}


// ============================================================
// APPLICATION ENTRY POINT
// ============================================================

runScraper()
  .then(() => {
    success("Application finished.");
  })
  .catch(err => {
    error(`Application terminated: ${err.message}`);
    process.exitCode = 1;
  });