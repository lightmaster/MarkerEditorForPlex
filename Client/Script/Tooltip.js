import { $, buildNode } from './Common.js';
import { ContextualLog } from '../../Shared/ConsoleLog.js';

const Log = new ContextualLog('Tooltip');

const windowMargin = 10;

/**
 * Implements common functionality for on-hover tooltips, offering expanded functionality over 'title'.
 * Taken from PlexWeb/script/Tooltip, but has strayed quite a bit from the original fork. */
export default class Tooltip {

    static #initialized = false;

    /** Contains the setTimeout id of a scroll event, which will hide the tooltip when expired
     * @type {number|null} */
    static #hideTooltipTimer = null;

    /** @type {number} `timerId` to keep track of the tooltip delay timeout. */
    static #tooltipTimer = null;

    /** @type {boolean} Keeps track of whether the tooltip is currently visible. */
    static #showingTooltip = false;

    /** @type {HTMLElement} The element whose tooltip is currently visible. */
    static #ttElement = null;

    static Setup() {
        if (Tooltip.#initialized) {
            return;
        }

        Tooltip.#initialized = true;
        const frame = $('#plexFrame');
        frame.appendChild(buildNode('div', { id : 'tooltip' }));
        frame.addEventListener('scroll', Tooltip.#onScroll);
        frame.addEventListener('keydown', Tooltip.dismiss); // Any keyboard input dismisses tooltips.
    }

    /**
     * Scroll handler. When detected, hide the tooltip (mainly for mobile devices).
     * Add a bit of delay, as it is a bit jarring to have it immediately go away.
     */
    static #onScroll() {
        if (Tooltip.#hideTooltipTimer) {
            clearTimeout(Tooltip.#hideTooltipTimer);
        }

        Tooltip.#hideTooltipTimer = setTimeout(() => { $('#tooltip').style.display = 'none'; }, 100);
    }

    /**
     * Sets up tooltip handlers for basic use cases.
     * @param {HTMLElement} element The element to add the tooltip to.
     * @param {string|HTMLElement} tooltip The tooltip text.
     * @param {number} [delay=250] The duration an element must be hovered before the tooltip is shown, in ms. */
    static setTooltip(element, tooltip, delay=250) {
        const hasTT = element.hasAttribute('tt');
        this.setText(element, tooltip);
        element.setAttribute('ttDelay', delay);
        if (!hasTT) {
            element.addEventListener('mousemove', Tooltip.#onMouseMove);
            element.addEventListener('mouseleave', Tooltip.dismiss);
            element.addEventListener('focusin', Tooltip.#onFocus);
            element.addEventListener('focusout', Tooltip.dismiss);
        }
    }

    /**
     * Handles tooltip positioning when the mouse location moves
     * @param {MouseEvent} e */
    static #onMouseMove(e) {
        Tooltip.showTooltip(e, this.getAttribute('tt'), this.getAttribute('ttDelay'));
    }

    /**
     * Simulate a MouseMove event when an element gains focus.
     * Note: this can be annoying without the global keydown dismissal, so make sure if anything
     *       changes there, we have a way of dismissing tooltips from focused elements.
     * @param {FocusEvent} e */
    static #onFocus(e) {
        // Don't do anything if we're already showing the tooltip for this item
        if (Tooltip.#showingTooltip && Tooltip.#ttElement === this) {
            return;
        }

        // Fill out values read by #showTooltipCore, as well as some sentinel values (focusX/Y)
        // that indicates our target is focused, and we should avoid making adjustments that causes
        // the tooltip to overlap the element itself.
        const rect = e.target.getBoundingClientRect();
        const fakeE = {
            target : e.target,
            clientY : rect.bottom,
            clientX : rect.left,
            focusY : rect.bottom - rect.top,
            focusX : rect.right - rect.left,
        };

        // Focus delay is a bit more than the default value of 250ms
        const delay = Math.max(500, parseInt(this.getAttribute('ttDelay')));
        Tooltip.showTooltip(fakeE, this.getAttribute('tt'), delay);
    }

    /**
     * Sets the tooltip text for the given element.
     * Assumes `element` has gone through the initial tooltip setup.
     * @param {HTMLElement} element
     * @param {string|HTMLElement} tooltip */
    static setText(element, tooltip) {
        const asString = (typeof tooltip === 'string' ? tooltip : tooltip.outerHTML);
        element.setAttribute('tt', asString);
        if (Tooltip.#showingTooltip && Tooltip.#ttElement === element) {
            $('#tooltip').innerHTML = tooltip;
        }
    }

    /**
     * Removes the tooltip from the given element
     * @param {HTMLElement} element */
    static removeTooltip(element) {
        element.removeAttribute('tt');
        element.removeEventListener('mousemove', Tooltip.#onMouseMove);
        element.removeEventListener('mouseleave', Tooltip.dismiss);
    }

    /**
     * Retrieve the current tooltip text for the given element,
     * or an empty string if it does not exist.
     * @param {HTMLElement} element
     */
    static getText(element) {
        return element.getAttribute('tt') || '';
    }

    /**
     * Updates the position of Show a tooltip with the given text at a position relative to the current clientX/Y.
     * If the tooltip is not currently visible, resets the delay timer.
     * @param {MouseEvent} e The MouseEvent that triggered this function.
     * @param {string} text The text to display.
     * @param {number} [delay=250] The delay before showing the tooltip, in ms. */
    static showTooltip(e, text, delay=250) {
        // If we have a raw string, shove it in a span first
        if (typeof(text) == 'string') {
            text = buildNode('span', {}, text);
        }

        if (Tooltip.#showingTooltip) {
            Tooltip.#showTooltipCore(e, text);
            return;
        }

        if (Tooltip.#tooltipTimer) {
            clearTimeout(Tooltip.#tooltipTimer);
        }

        Tooltip.#tooltipTimer = setTimeout(Tooltip.#showTooltipCore, delay, e, text);
    }

    /**
     * Cached border width of the tooltip. Assumes that it does not change over the course of the session
     * @type {number?} */
    static #tooltipBorderAdjustment = undefined;

    /**
     * Retrieve the border width of the tooltip. If we have a cached value, return it,
     * otherwise do the one-time calculation.
     * @param {HTMLElement} tooltip
     * @return {number} */
    static #borderWidth(tooltip) {
        if (Tooltip.#tooltipBorderAdjustment !== undefined) {
            return Tooltip.#tooltipBorderAdjustment;
        }

        const style = getComputedStyle(tooltip);
        Tooltip.#tooltipBorderAdjustment = parseInt(style.borderLeftWidth) + parseInt(style.borderRightWidth);
        return Tooltip.#tooltipBorderAdjustment;
    }

    /**
     * Core routine to show a tooltip and update its position.
     * Should not be called outside of this file.
     * @param {MouseEvent} e The MouseEvent that triggered this function.
     * @param {HTMLElement} text The tooltip Element containing the tooltip text. */
    static #showTooltipCore(e, text) {
        if (!Tooltip.#showingTooltip) {
            Log.tmi(text, `Launching tooltip`);
        }

        Tooltip.#ttElement = e.target;
        while (Tooltip.#ttElement && !Tooltip.#ttElement.hasAttribute('tt')) {
            Tooltip.#ttElement = Tooltip.#ttElement.parentElement;
        }

        Tooltip.#showingTooltip = true;
        const tooltip = $('#tooltip');

        const ttUpdated = Tooltip.#ttElement && Tooltip.#ttElement.getAttribute('tt');
        if (ttUpdated) {
            tooltip.innerHTML = ttUpdated;
        } else {
            tooltip.innerHTML = '';
            tooltip.appendChild(text);
        }

        tooltip.style.display = 'inline';

        const extraMargin = e.focusY ? 5 : 20; // Focus triggers don't need as much of a margin
        const heightAdjust = tooltip.clientHeight + extraMargin + windowMargin;
        const rawHeight = e.clientY + window.scrollY;
        const maxHeight = document.body.clientHeight + window.scrollY - heightAdjust;
        tooltip.style.top = (Math.min(rawHeight, maxHeight) + extraMargin) + 'px';

        const avoidOverlay = rawHeight > maxHeight ? 10 : 0;
        // Border isn't included in clientWidth, which can cause us to slowly shrink a tooltip that's on the right edge.
        const borderAdjust = Tooltip.#borderWidth(tooltip);
        const widthAdjust = tooltip.clientWidth + windowMargin + avoidOverlay + borderAdjust;
        const maxWidth = document.body.clientWidth + window.scrollX - widthAdjust;
        tooltip.style.left = (Math.min(e.clientX + window.scrollX, maxWidth) + avoidOverlay) + 'px';
        if (maxWidth < e.clientX + window.scrollX && rawHeight + heightAdjust > document.body.clientHeight + window.scrollY) {
            // Adjusting x & y, move tooltip completely above cursor
            tooltip.style.top = (rawHeight - heightAdjust + extraMargin - (e.focusY ?? 0)) + 'px';
        }
    }

    /** Dismisses the tooltip. */
    static dismiss() {
        if (Tooltip.#showingTooltip) {
            Log.tmi(`Dismissing tooltip: ${$('#tooltip').innerHTML}`);
        }

        $('#tooltip').style.display = 'none';
        clearTimeout(Tooltip.#tooltipTimer);
        Tooltip.#tooltipTimer = null;
        Tooltip.#showingTooltip = false;
    }

    /**
     * @returns `true` if we're currently showing a tooltip.
     */
    static active() {
        return Tooltip.#showingTooltip;
    }
}
