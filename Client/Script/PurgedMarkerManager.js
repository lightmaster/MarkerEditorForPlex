import { Log } from "../../Shared/ConsoleLog.js";
import { MarkerData, SectionType } from "../../Shared/PlexTypes.js";
import ButtonCreator from "./ButtonCreator.js";
import { $$, appendChildren, buildNode, clearEle, errorMessage, errorResponseOverlay, ServerCommand, pad0 } from "./Common.js";
import Animation from "./inc/Animate.js";
import Overlay from "./inc/Overlay.js";
import Tooltip from "./inc/Tooltip.js";
import PlexClientState from "./PlexClientState.js";
import { PurgedServer, PurgedShow, PurgedSeason, PurgedEpisode, AgnosticPurgeCache, PurgeCacheStatus, PurgedSection, PurgedMovieSection, PurgedGroup, PurgedMovie, PurgedTVSection } from "./PurgedMarkerCache.js"
import TableElements from "./TableElements.js";
import ThemeColors from "./ThemeColors.js";

/** @typedef {!import('../../Shared/PlexTypes').MarkerAction} MarkerAction */
/** @typedef {!import('../../Shared/PlexTypes.js').PurgeSection} PurgeSection */
/** @typedef {!import("../../Server/PlexQueryManager.js").RawMarkerData} RawMarkerData */


/**
 * A class that holds the information relevant for a button callback
 * that makes a request to the server.
 */
 class PurgeActionInfo {
    static #nop = () => {};

    /** @type {string} */
    text;
    /** @type {() => void} */
    successFn;
    /** @type {() => void} */
    failureFn;

    /**
     * @param {string} text Button text.
     * @param {*} successFn Function invoked when the server request succeeds.
     * @param {*} failureFn Function invoked when the serve request fails. */
    constructor(text, successFn, failureFn) {
        this.text = text;
        this.successFn = successFn || PurgeActionInfo.#nop;
        this.failureFn = failureFn || PurgeActionInfo.#nop;
    }
}

/**
 * A class that holds the information relevant for a button callback
 * that changes UI state, but does not make a request to the server.
 */
class PurgeNonActionInfo {
    /** @type {string} */
    text;
    /** @type {() => void} */
    callback;

    /**
     * @param {string} text The button text.
     * @param {() => void} callback The callback to invoke when the button is clicked, if any. */
    constructor(text, callback) {
        this.text = text;
        this.callback = callback || (() => {});
    }
}

/**
 * Encapsulates the restore/ignore interactions for the purge overlay. Can be
 * used at any level, i.e. at the section, season, or individual marker level.
 */
 class PurgeOptions {
    /** @type {HTMLElement} */
    #parent;
    /** @type {boolean} */
    #inOperation;
    /** @type {PurgeActionInfo} */
    #restoreInfo;
    /** @type {PurgeNonActionInfo} */
    #ignoreInfo;
    /** @type {PurgeActionInfo} */
    #ignoreConfirmInfo;
    /** @type {PurgeNonActionInfo} */
    #ignoreCancelInfo;
    /** @type {() => number[]} */
    #getMarkersFn;

    /** @param {HTMLElement} parent The element that will hold this class's HTML. */
    constructor(parent) {
        this.#parent = parent;
    }

    /**
     * Create the restore/ignore buttons and add them to the parent element.
     * @param {PurgeActionInfo} restoreInfo Properties for the 'Restore' button.
     * @param {PurgeNonActionInfo} ignoreInfo Properties for the 'Ignore' button.
     * @param {PurgeActionInfo} ignoreConfirmInfo Properties for the 'Confirm ignore' button.
     * @param {PurgeNonActionInfo} ignoreCancelInfo Properties for the 'Cancel ignore' button.
     * @param {() => number[]} getMarkersFn Function that returns the list of marker ids this class applies to. */
    addButtons(restoreInfo, ignoreInfo, ignoreConfirmInfo, ignoreCancelInfo, getMarkersFn) {
        this.#restoreInfo = restoreInfo;
        this.#ignoreInfo = ignoreInfo;
        this.#ignoreConfirmInfo = ignoreConfirmInfo;
        this.#ignoreCancelInfo = ignoreCancelInfo;
        this.#getMarkersFn = getMarkersFn;
        appendChildren(this.#parent,
            ButtonCreator.fullButton(
                restoreInfo.text,
                'confirm',
                'Restore Markers',
                'green',
                this.#onRestore.bind(this),
                { class : 'restoreButton' }),
            ButtonCreator.fullButton(
                ignoreInfo.text,
                'delete',
                'Ignore Markers',
                'red',
                this.#onIgnoreClick.bind(this),
                { class : 'ignoreButton' }),
            ButtonCreator.fullButton(
                ignoreConfirmInfo.text,
                'confirm',
                'Ignore Markers',
                'green',
                this.#onIgnoreConfirm.bind(this),
                { class : 'ignoreConfirm hidden' }),
            ButtonCreator.fullButton(
                ignoreCancelInfo.text,
                'cancel',
                'Cancel Ignore',
                'red',
                this.#onIgnoreCancel.bind(this),
                { class : 'ignoreCancel hidden' })
        );
    }

    /** Reset the current view after cancelling an 'ignore' or after a failed operation */
    resetViewState() {
        this.#exitOperation();
        this.#onIgnoreCancel();
    }

    /**
     * Marks this action as in progress, preventing other actions on the same
     * set of markers from going through.
     * @returns {boolean} Whether it's okay to begin the operation.
     */
    #enterOperation() {
        if (this.#inOperation) {
            Log.verbose('Already in an operation, ignoring action click.');
            return false;
        }

        this.#inOperation = true;
        return true;
    }

    /** Exit the current operation, in either success or failure. */
    #exitOperation() {
        if (!this.#inOperation) {
            Log.warn(`Attempting to exit an action that wasn't set!`);
        }

        this.#inOperation = false;
    }

    /** Kicks off the restoration process for the markers this operation applies to. */
    async #onRestore() {
        if (!this.#enterOperation()) { return; }
        const markers = this.#getMarkersFn();
        Log.verbose(`Attempting to restore ${markers.length} marker(s).`);
        $$('.restoreButton img', this.#parent).src = ThemeColors.getIcon('loading', 'green');

        try {
            const restoreData = await ServerCommand.restorePurge(markers, PlexClientState.GetState().activeSection());
            this.#resetConfirmImg('restoreButton');
            this.#restoreInfo.successFn(restoreData.newMarkers);
        } catch (err) {
            errorMessage(err); // For logging
            this.#resetConfirmImg('restoreButton');
            this.#restoreInfo.failureFn();
        }
    }

    /** Resets the 'confirm' image icon after getting a response from a restore/ignore request. */
    #resetConfirmImg(className) {
        $$(`.${className} img`, this.#parent).src = ThemeColors.getIcon('confirm', 'green');
    }

    /** Shows the confirmation buttons after 'Ignore' is clicked. */
    #onIgnoreClick() {
        if (this.#inOperation) { return; }
        $$('.restoreButton', this.#parent).classList.add('hidden');
        $$('.ignoreButton', this.#parent).classList.add('hidden');
        $$('.ignoreConfirm', this.#parent).classList.remove('hidden');
        $$('.ignoreCancel', this.#parent).classList.remove('hidden');
        this.#ignoreInfo.callback();
    }

    /** Kicks off the ignore process for the markers this operation applies to. */
    async #onIgnoreConfirm() {
        if (!this.#enterOperation()) { return; }
        const markers = this.#getMarkersFn();
        Log.verbose(`Attempting to ignore ${markers.length} marker(s).`);
        $$('.ignoreConfirm img', this.#parent).src = ThemeColors.getIcon('loading', 'green');

        try {
            await ServerCommand.ignorePurge(markers, PlexClientState.GetState().activeSection());
            this.#resetConfirmImg('ignoreConfirm');
            this.#ignoreConfirmInfo.successFn();
        } catch (err) {
            errorMessage(err); // For logging
            this.#resetConfirmImg('ignoreConfirm');
            this.#ignoreConfirmInfo.failureFn();
        }
    }

    /** Resets the operation view after the user cancels the ignore operation. */
    #onIgnoreCancel() {
        $$('.restoreButton', this.#parent).classList.remove('hidden');
        $$('.ignoreButton', this.#parent).classList.remove('hidden');
        $$('.ignoreConfirm', this.#parent).classList.add('hidden');
        $$('.ignoreCancel', this.#parent).classList.add('hidden');
        this.#ignoreCancelInfo.callback();
    }
}

/**
 * The PurgeRow represents a single row in the PurgeTable.
 */
 class PurgeRow {
     /**
      * The number of columns to backup and clear out when showing an inline row message.
      * @type {number} */
     static #backupLength = 4;

    /** @type {MarkerAction} */
    #markerAction;

    /**
     * Callback to invoke after the table this row belongs to is empty.
     * @type {() => void} */
    #emptyTableCallback;

    /** Marker data converted from `#markerAction`
     * #@type {MarkerData} */
    #markerData;

    /** @type {HTMLElement} */
    #html;

    /** Cached `td`s of the main row, as `#html` can change. */
    #tableData = [];

    /** @type {PurgeOptions} */
    #purgeOptions;

    /**
     * Create a new row for a purged marker.
     * @param {MarkerAction} markerAction The action this row represents.
     * @param {() => void} emptyTableCallback Callback to invoke after the table this row belongs to is empty. */
    constructor(markerAction, emptyTableCallback) {
        this.#markerAction = markerAction;
        this.#markerData = this.#markerDataFromMarkerAction();
        this.#emptyTableCallback = emptyTableCallback;
    }

    /** Builds and returns a table row for this purged marker. */
    buildRow() {
        this.#html = TableElements.rawTableRow(...(this.customTableColumns().concat(this.#tableColumnsCommon())));

        this.#html.classList.add('purgerow');

        this.#html.id = `purgerow_${this.#markerAction.marker_id}`;

        return this.#html;
    }

    /** @returns {MarkerAction} */
    markerAction() { return this.#markerAction; }

    /** @returns {HTMLElement[]} */
    customTableColumns() { Log.error(`customTableColumns cannot be called directly on PurgeRow.`); return []; }

    /** @returns {HTMLElement[]} */
    #tableColumnsCommon() {
        return [
            TableElements.timeData(this.#markerAction.start),
            TableElements.timeData(this.#markerAction.end),
            TableElements.dateColumn(TableElements.friendlyDate(this.#markerData)),
            this.#addPurgeOptions()
        ];
    }

    /** Creates the restore/ignore option buttons for this row. */
    #addPurgeOptions() {
        let holder = buildNode('div', { class : 'purgeOptionsHolder' });
        this.#purgeOptions = new PurgeOptions(holder);
        this.#purgeOptions.addButtons(
            new PurgeActionInfo('Restore', this.#onRestoreSuccess.bind(this), this.#onRestoreFail.bind(this)),
            new PurgeNonActionInfo('Ignore', this.#onIgnore.bind(this)),
            new PurgeActionInfo('Yes', this.#onIgnoreSuccess.bind(this), this.#onIgnoreFailed.bind(this)),
            new PurgeNonActionInfo('No', this.#onIgnoreCancel.bind(this)),
            /**@this {PurgeRow}*/function() { return [this.#markerAction.marker_id]; }.bind(this)
        );

        return holder;
    }

    /** Sends a notification to the client state that a marker has been restored/ignored.
     * @param {MarkerData[]?} _newMarkerArr The newly restored marker as a single element array, or null if the purged marker was ignored. */
    notifyPurgeChange(_newMarkerArr=null) { Log.error(`notifyPurgeChange should not be called on the base class.`) }

    /** Callback when a marker was successfully restored. Flashes the row and then removes itself.
     * @param {MarkerData[]} newMarker The newly restored marker, in the form of a single-element array. */
    #onRestoreSuccess(newMarker) {
        Animation.queue({ backgroundColor : `#${ThemeColors.get('green')}6` }, this.#html, 500);
        Animation.queueDelayed({ color : 'transparent', backgroundColor : 'transparent', height : '0px' }, this.#html, 500, 500, false, this.#removeSelfAfterAnimation.bind(this));
        this.notifyPurgeChange(newMarker);
    }

    /** Callback when a marker failed to be restored. Flashes the row and then resets back to its original state. */
    #onRestoreFail() {
        this.#showRowMessage('Restoration failed. Please try again later.');
        Animation.queue({ backgroundColor : `#${ThemeColors.get('red')}4` }, this.#html, 500);
        Animation.queueDelayed({ backgroundColor : 'transparent' }, this.#html, 500, 500, true, this.#resetSelfAfterAnimation.bind(this));
    }

    /** After an animation completes, remove itself from the table. */
    #removeSelfAfterAnimation() {
        const parent = this.#html.parentElement;
        parent.removeChild(this.#html);
        if (parent.children.length == 0) {
            this.#emptyTableCallback();
        }
    }

    /** After an animation completes, restore the row to its original state. */
    #resetSelfAfterAnimation() {
        this.#purgeOptions.resetViewState();
    }

    /** Callback when the user clicks 'Ignore'. Replaces the row with an 'Are you sure' prompt. */
    #onIgnore() {
        this.#showRowMessage('Are you sure you want to permanently ignore this marker?');
    }

    /** Callback when the user decides to cancel the ignore operation, resetting the row to its original state. */
    #onIgnoreCancel() {
        this.#restoreTableData();
    }

    /** Callback when a marker was successfully ignored. Flash the row and remove it. */
    #onIgnoreSuccess() {
        Animation.queue({ backgroundColor : `#${ThemeColors.get('green')}4` }, this.#html, 500);
        Animation.queueDelayed({ backgroundColor : 'transparent' }, this.#html, 500, 500, true, this.#removeSelfAfterAnimation.bind(this));
        this.notifyPurgeChange();
    }

    /** Callback when a marker failed to be ignored. Flash the row and reset it back to its original state. */
    #onIgnoreFailed() {
        this.#html.children[0].innerText = 'Sorry, something went wrong. Please try again later.';
        Animation.queue({ backgroundColor : `#${ThemeColors.get('red')}4` }, this.#html, 500);
        Animation.queueDelayed({ backgroundColor : 'transparent' }, this.#html, 500, 500, true, this.#resetSelfAfterAnimation.bind(this));
    }

    #showRowMessage(message) {
        this.#backupTableData();
        for (let i = 0; i < PurgeRow.#backupLength; ++i) {
            this.#html.removeChild(this.#html.firstChild);
        }

        this.#html.insertBefore(buildNode('td', { colspan : 4, class : 'spanningTableRow' }, message), this.#html.firstChild);
    }

    /** Backs up the main content of the row in preparation of `#html` being cleared out. */
    #backupTableData() {
        if (this.#tableData.length != 0) {
            return;
        }

        for (let i = 0; i < PurgeRow.#backupLength; ++i) {
            this.#tableData.push(this.#html.children[i]);
        }
    }

    /** Restores the main content of this row with the backed up data. */
    #restoreTableData() {
        this.#html.removeChild(this.#html.firstChild);
        for(let i = PurgeRow.#backupLength - 1; i >= 0; --i) {
            this.#html.insertBefore(this.#tableData[i], this.#html.firstChild);
        }
    }

    /** Translates MarkerAction columns to RawMarkerData, or as close as we can get. */
    #markerDataFromMarkerAction() {
        /** @type {RawMarkerData} */
        const rawMarkerData = {
            id : this.#markerAction.marker_id,
            index : -1,
            start : this.#markerAction.start,
            end : this.#markerAction.end,
            modified_date : this.#markerAction.modified_at,
            created_at : this.#markerAction.created_at,
            parent_id : this.#markerAction.parent_id,
            season_id : this.#markerAction.season_id,
            show_id : this.#markerAction.show_id,
            section_id : PlexClientState.GetState().activeSection(),
            marker_type : this.#markerAction.marker_type,
            final : this.#markerAction.final,
        };

        return new MarkerData(rawMarkerData);
    }
}

/**
 * A PurgeRow for a marker that belongs to a TV episode, mainly differing in the
 * addition of an 'episode title' row, and how notifications are send back to the client.
 */
class TVPurgeRow extends PurgeRow {
    /**
     * Return the list of columns specific to TV shows. In this case, the marker type
     * and episode title. The marker type isn't really shared, but it it makes building
     * the entire row more manageable to repeat it.
     * @returns {HTMLElement[]} */
    customTableColumns() {
        const ep = this.markerAction().episodeData;
        return [
            buildNode('span', {}, this.markerAction().marker_type),
            buildNode('span', { title : ep.title }, `S${pad0(ep.seasonIndex, 2)}E${pad0(ep.index, 2)}`),
        ];
    }

    /**
     * Sends a notification to the client state that a marker has been restored/ignored.
     * @param {MarkerData[]?} newMarkerArr The newly restored marker as a single element array, or null if the purged marker was ignored. */
    notifyPurgeChange(newMarkerArr=null) {
        const markerAction = this.markerAction();
        let dummyLibrary = new PurgedTVSection();
        let dummyShow = new PurgedShow(markerAction.show_id, dummyLibrary);
        let dummySeason = new PurgedSeason(markerAction.season_id, dummyShow);
        let dummyEpisode = new PurgedEpisode(markerAction.parent_id, dummySeason);
        dummyLibrary.addInternal(dummyShow.id, dummyShow);
        dummyShow.addInternal(dummySeason.id, dummySeason);
        dummySeason.addInternal(dummyEpisode.id, dummyEpisode);
        dummyEpisode.addNewMarker(markerAction);
        PurgedMarkerManager.GetManager().onPurgedMarkerAction(dummyLibrary, newMarkerArr);
    }
}

/**
 * A PurgeRow for a marker that belongs to a movie. Unlike a TV marker row, a movie
 * marker row doesn't need to have a column indicating the title.
 */
class MoviePurgeRow extends PurgeRow {
    /**
     * @returns {HTMLElement} */
    customTableColumns() {
        return  [
            buildNode('span', {}, this.markerAction().marker_type),
        ];
    }

    /**
     * Sends a notification to the client state that a marker has been restored/ignored.
     * @param {MarkerData[]?} newMarkerArr The newly restored marker as a single element array, or null if the purged marker was ignored. */
    notifyPurgeChange(newMarkerArr=null) {
        const markerAction = this.markerAction();
        let dummyLibrary = new PurgedMovieSection();
        let dummyMovie = new PurgedMovie(markerAction.parent_id, dummyLibrary);
        dummyLibrary.addInternal(dummyMovie.id, dummyMovie);
        dummyMovie.addNewMarker(markerAction);
        PurgedMarkerManager.GetManager().onPurgedMarkerAction(dummyLibrary, newMarkerArr);
    }
}

/**
 * Common class for handling bulk purge actions
 */
class BulkPurgeAction {
    /** @type {() => number[]} */
    #getMarkersFn;
    /** @type {() => void} */
    #successCallback;
    /** @type {HTMLElement} */
    #html;
    /** @type {PurgeOptions} */
    #options;

    /**
     * Create a new bulk purge action.
     * @param {string} id The HTML id for this action group.
     * @param {string} restoreText Text for the 'restore all' button.
     * @param {string} ignoreText Text for the 'ignore all' button.
     * @param {() => void} successCallback Callback invoked after successfully restoring or ignoring this marker group.
     * @param {() => number[]} getMarkersFn Function that returns the list of marker ids this action applies to. */
    constructor(id, restoreText, ignoreText, successCallback, getMarkersFn) {
        this.#successCallback = successCallback;
        this.#getMarkersFn = getMarkersFn;
        // Just create all four necessary buttons instead of dealing with overwriting/adding/removing
        // various button states. Just deal with hidden/visible.
        this.#html = buildNode('div', { class : 'buttonContainer', id : id });
        this.#options = new PurgeOptions(this.#html);
        this.#options.addButtons(
            new PurgeActionInfo(restoreText, this.#onRestoreSuccess.bind(this), this.#onRestoreFail.bind(this)),
            new PurgeNonActionInfo(ignoreText),
            new PurgeActionInfo('Confirm', this.#onIgnoreSuccess.bind(this), this.#onIgnoreFailed),
            new PurgeNonActionInfo('Cancel'),
            this.#getMarkersFn);
    }

    /** @returns {HTMLElement} The HTML that encapsulates this action. */
    html() { return this.#html; }

    /** Callback invoked when markers were successfully restored.
     * @param {MarkerData[]} newMarkers Array of newly restored markers. */
    #onRestoreSuccess(newMarkers) {
        this.#onActionSuccess(newMarkers);
    }

    /** Callback invoked when markers were unsuccessfully restored. */
    #onRestoreFail() {
        this.#options.resetViewState();
        Animation.queue({ backgroundColor : `#${ThemeColors.get('red')}4` }, this.#html, 250);
        Animation.queueDelayed({ backgroundColor : 'transparent' }, this.#html, 500, 250, true);
    }

    /** Callback invoked when markers were successfully ignored. */
    #onIgnoreSuccess() {
        // Don't exit bulk update, since changes have been committed and the table should be invalid now.
        this.#onActionSuccess();
    }

    /** Callback invoked when we failed to ignore this marker group. */
    #onIgnoreFailed() {
        Animation.queue({ backgroundColor : `#${ThemeColors.get('red')}4` }, this.#html, 500);
        Animation.queueDelayed({ backgroundColor : 'transparent' }, this.#html, 500, 500, true, this.#options.resetViewState.bind(this.#options));
    }

    /** Common actions done when markers were successfully restored or ignored. */
    #onActionSuccess(newMarkers=null) {
        // Don't exit bulk update, since changes have been committed and the table should be invalid now.
        Animation.queue({ backgroundColor : `#${ThemeColors.get('green')}6` }, this.#html, 250);

        const wrappedCallback = /**@this {BulkPurgeAction}*/ function() {
            this.#successCallback(newMarkers);
        }.bind(this);

        Animation.queueDelayed({ backgroundColor : 'transparent' }, this.#html, 500, 250, true, wrappedCallback);
    }
}

/**
 * Available purge overlay modes.
 */
const DisplayType = {
    /** Display all purged markers for a given section. */
    All : 0,
    /** Display all purged markers for a given season of a show. */
    SingleSeason : 1,
    /** Display a single purged marker */
    SingleEpisode : 2
}

/**
 * Represents purged markers for a single show. It may be a subset when
 * DisplayType is SingleSeason or SingleEpisode, but it groups all of them
 * into a single table.
 */
class PurgeTable {
    /** @type {PurgedGroup} */
    #purgedGroup;
    /** @type {HTMLElement} */
    #html;
    /** @type {boolean} */
    #removed;
    /** @type {() => void} */
    #removedCallback;
    /** @type {DisplayType} */
    #displayType;

    /**
     * Create a new table for one or more purged markers in a single show.
     * @param {PurgedGroup} purgedGroup Group of purged markers in this show/movie.
     * @param {() => void} removedCallback Callback invoked when all markers are ignored or restored.
     * @param {DisplayType=DisplayType.All} displayType The type of overlay being shown. */
    constructor(purgedGroup, removedCallback, displayType=DisplayType.All) {
        this.#purgedGroup = purgedGroup;
        this.#removedCallback = removedCallback;
        this.#displayType = displayType;
        this.#removed = false;
    }

    /** @returns {HTMLElement} The HTML associated with this table. */
    html() {
        if (this.#html) {
            return this.#html;
        }

        const firstMarker = this.#purgedGroup.getAny();
        const typePrefix = (this.#purgedGroup instanceof PurgedShow) ? 'purgeshow' : 'purgemovie';
        const countPostfix = (this.#purgedGroup instanceof PurgedShow) ? firstMarker.show_id : firstMarker.parent_id;
        let container = buildNode('div', { class : 'purgeGroupContainer', id : `${typePrefix}_${countPostfix}` });
        if (this.#displayType == DisplayType.All) {
            // <hr> to break up different shows if we're showing all purges in the section
            container.appendChild(buildNode('hr'));
        }

        container.appendChild(buildNode('h2', {}, this.mainTitle()));
        if (this.markerIds().length > 1) {
            // Only show bulk operation actions if we're not showing a single marker
            container.appendChild(
                new BulkPurgeAction(
                    `${typePrefix}_bulk_${countPostfix}`,
                    'Restore All',
                    'Ignore All',
                    this.#onBulkActionSuccess.bind(this),
                    this.markerIds.bind(this)).html());
        }

        let table = buildNode('table', { class : 'markerTable' });
        table.appendChild(appendChildren(buildNode('thead'), this.tableHeader()));

        let rows = buildNode('tbody');
        this.#forMarker(function(marker, rows) {
            rows.appendChild(this.getNewPurgedRow(marker, this.#onRowRemoved.bind(this)).buildRow());
        }, rows);

        table.appendChild(rows);
        container.appendChild(table);
        this.#html = container;
        return container;
    }

    /** @returns {string} */
    mainTitle() { Log.error(`mainTitle cannot be called on the base class.`); return ''; };
    /** @returns {HTMLElement} */
    tableHeader() { Log.error(`tableHeader cannot be called on the base class.`); return buildNode('span'); }
    /** @returns {PurgeRow} */
    getNewPurgedRow() { Log.error(`getNewPurgedRow cannot be called on the base class.`); }

    /** @returns {PurgedGroup} */
    purgedGroup() { return this.#purgedGroup; }

    /** @returns {boolean} Whether this section has been removed due to successful restores/ignores. */
    removed() { return this.#removed; }

    /** Callback invoked when all markers in the table have been handled.
     * @param {MarkerData[]} newMarkers The newly restored markers, or null if the purged markers were ignored. */
    #onBulkActionSuccess(newMarkers=null) {
        this.#onRowRemoved();
        let allMarkers = [];
        this.#forMarker(marker => allMarkers.push(marker));
        let dummyLibrary = new PurgedSection();
        // Need a deep copy of purgedShow so we don't get confused between markers that are
        // still purged and those that were just cleared in onPurgedMarkerAction.
        dummyLibrary.addInternal(this.#purgedGroup.id, this.#purgedGroup.deepClone());
        PurgedMarkerManager.GetManager().onPurgedMarkerAction(dummyLibrary, newMarkers);
    }

    /**
     * Animate the removal of this row */
    #onRowRemoved() {
        this.#removed = true;
        Animation.queue({ opacity : 0, height : '0px' }, this.#html, 250, true, this.#removedCallback);
    }

    /**
     * Helper that applies the given function to all markers in the table.
     * @param {(MarkerAction, ...any) => void} fn The function to apply to each marker.
     * @param  {...any} args Additional arguments to pass into fn.
     */
    #forMarker(fn, ...args) {
        this.#purgedGroup.forEach(/**@this {PurgeTable}*/function(marker) {
            fn.bind(this)(marker, ...args);
        }.bind(this));
    }

    /** @returns The list of markers in this table. */
    markerIds() {
        let ids = [];
        this.#forMarker(function(marker, ids) {
            ids.push(marker.marker_id);
        }, ids);
        return ids;
    }
}

/**
 * A purge table for an entire TV show.
 */
class TVPurgeTable extends PurgeTable {
    /** @returns {PurgedShow} */
    purgedGroup() { return super.purgedGroup(); }
    /** @returns {string} */
    mainTitle() {
        return this.purgedGroup().getAny().episodeData.showName;
    }

    /** @returns {HTMLElement} */
    tableHeader() {
        return TableElements.rawTableRow(
            'Type',
            'Episode',
            TableElements.shortTimeColumn('Start Time'),
            TableElements.shortTimeColumn('End Time'),
            TableElements.dateColumn('Date Added'),
            TableElements.optionsColumn('Options'));
    }

    /** @returns {TVPurgeRow} */
    getNewPurgedRow(marker, callback) {
        return new TVPurgeRow(marker, callback);
    }
}

/**
 * A purge table for a single movie.
 */
class MoviePurgeTable extends PurgeTable {
    /** @returns {PurgedMovie} */
    purgedGroup() { return super.purgedGroup(); }
    /** @returns {string} */
    mainTitle() {
        const movieData = this.purgedGroup().getAny().movieData;
        return `${movieData.title} (${movieData.year})`;
    }

    /** @returns {HTMLElement} */
    tableHeader() {
        return TableElements.rawTableRow(
            'Type',
            TableElements.shortTimeColumn('Start Time'),
            TableElements.shortTimeColumn('End Time'),
            TableElements.dateColumn('Date Added'),
            TableElements.optionsColumn('Options'));
    }

    /** @returns {MoviePurgeRow} */
    getNewPurgedRow(marker, callback) {
        return new MoviePurgeRow(marker, callback);
    }
}

/**
 * Manages the 'find all purged markers' overlay.
 */
class PurgeOverlay {
    /** @type {PurgedSection} */
    #purgedSection;
    /**
     * The list of tables in this overlay, one per top-level item (movie/show).
     * @type {PurgeTable[]} */
    #tables = [];
    /** @type {HTMLElement} */
    #html;

    /**
     * Initialize a new purge overlay.
     * @param {PurgedSection} purgedSection The purge data to display.
     */
    constructor(purgedSection) {
        this.#purgedSection = purgedSection;
    }

    /** Display the main overlay. */
    show() {
        // Main header + restore/ignore all buttons
        let container = buildNode('div', { id : 'purgeContainer' });
        appendChildren(container,
            buildNode('h1', {}, 'Purged Markers'),
            new BulkPurgeAction('purge_all', 'Restore All Markers', 'Ignore All Markers', this.#onBulkActionSuccess.bind(this), this.#getAllMarkerIds.bind(this)).html()
        );

        // Table for every top-level item that has purged markers. I.e. for each movie or for each show.
        for (const topLevelItem of Object.values(this.#purgedSection.data)) {
            if (topLevelItem.count <= 0) {
                continue;
            }

            const table = topLevelItem instanceof PurgedMovie ? new MoviePurgeTable(topLevelItem, this.#tableRemovedCallback.bind(this)) : new TVPurgeTable(topLevelItem, this.#tableRemovedCallback.bind(this));
            this.#tables.push(table);
            container.appendChild(table.html());
        }

        this.#html = container;
        if (this.#purgedSection.count <= 0) {
            this.#clearOverlayAfterPurge(true /*emptyOnInit*/);
        }

        Overlay.build({ dismissible : true, closeButton : true }, container);
    }

    /** Callback invoked when an entire table is removed from the overlay. */
    #tableRemovedCallback() {
        for (const table of this.#tables) {
            if (!table.removed()) {
                return;
            }
        }

        this.#onTableRemoved();
    }

    /** Callback invoked when all tables in the overlay have been handled.
     * @param {MarkerData[]} newMarkers Array of newly restored markers, or null if the purged markers were ignored. */
    #onBulkActionSuccess(newMarkers=null) {
        this.#onTableRemoved();
        PurgedMarkerManager.GetManager().onPurgedMarkerAction(this.#purgedSection.deepClone(), newMarkers);
    }

    /**
     * Animate the removal of all items in this overlay */
    #onTableRemoved() {
        Animation.queue({ opacity : 0 }, this.#html, 500, false, this.#clearOverlayAfterPurge.bind(this));
    }

    /** Clears out the now-useless overlay and lets the user know there are no more purged markers to handle. */
    #clearOverlayAfterPurge(emptyOnInit=false) {
        clearEle(this.#html);
        appendChildren(this.#html,
            buildNode('h1', {}, emptyOnInit ? 'No Purged Markers Found' : 'No More Purged Markers'),
            appendChildren(buildNode('div', { class : 'buttonContainer' }),
                ButtonCreator.textButton('OK', Overlay.dismiss, { class : 'overlayInput overlayButton' })));
        Animation.queue({ opacity : 1 }, this.#html, 500);
    }

    /** @returns {number[]} The list of marker ids this overlay applies to. */
    #getAllMarkerIds() {
        let allMarkers = [];
        for (const table of this.#tables) {
            if (!table.removed()) {
                allMarkers.push(...table.markerIds());
            }
        }

        return allMarkers;
    }
}

/**
 * Manages purged markers, i.e. markers that the user added/edited, but Plex removed for one reason
 * or another, most commonly because a new file was added to a season with modified markers.
 * TODO: Consolidate/integrate/reconcile with PurgeTable
 */
class PurgedMarkerManager {
    static #manager;

    /**
     * Hierarchical cache of known purged markers in the current server.
     * @type {PurgedServer} */
    #serverPurgeInfo = new PurgedServer();

    /**
     * Maps metadata ids (whether it's a show, season, episode, or movie) to their associated PurgedGroup.
     * @type {AgnosticPurgeCache} */
    #purgeCache = new AgnosticPurgeCache();

    /** Create a new manager for the given client state.
     * @param {boolean} findAllEnabled Whether the user can search for all purged markers for a given section. */
    constructor(findAllEnabled) {
        if (findAllEnabled) {
            $$('#findAllPurgedHolder').classList.remove('hidden');
            const button = $$('#purgedMarkers');
            $$('#purgedMarkers').addEventListener('click', this.findPurgedMarkers.bind(this, false));
            Tooltip.setTooltip(button, 'Search for user modified markers<br>that Plex purged from its database.');
        }

        PurgedMarkerManager.#manager = this;
    }

    /**
     * Retrieve the singleton manager instance.
     * @returns {PurgedMarkerManager} */
    static GetManager() { return this.#manager; }

    /**
     * Find all purged markers for the current library section.
     * @param {boolean} [dryRun=false] Whether we just want to populate our purge data, not show it. */
    async findPurgedMarkers(dryRun=false) {
        const section = PlexClientState.GetState().activeSection();
        const cachedSection = this.#serverPurgeInfo.get(section);
        if (cachedSection && cachedSection.status == PurgeCacheStatus.Complete) {
            // We have full cached data, used that.
            Log.tmi(`PurgedMarkerManager::findPurgedMarkers: Found cached data, bypassing all_purges call to server.`);
            if (!dryRun) {
                new PurgeOverlay(cachedSection, section).show();
            }

            return;
        }

        try {
            this.#onMarkersFound(await ServerCommand.allPurges(section), dryRun);
        } catch (err) {
            errorResponseOverlay(`Something went wrong retrieving purged markers. Please try again later.`, err);
        }
    };

    /** Retrieve all purged markers for the show with the given metadata id.
     * @param {number} showId
     * @throws {Error} if the purge_check fails */
    async getPurgedShowMarkers(showId) {
        let section = this.#serverPurgeInfo.getOrAdd(PlexClientState.GetState().activeSection());
        let show = section.getOrAdd(showId);

        if (show.status == PurgeCacheStatus.Complete) {
            return;
        } else if (show.status == PurgeCacheStatus.PartiallyInitialized) {
            // Partial state, this shouldn't happen! Overwrite.
            show = section.addNewGroup(show.id);
        }

        // No try/catch, caller must handle
        /** @type {MarkerAction[]} */
        const actions = await ServerCommand.purgeCheck(showId);
        for (const action of actions) {
            this.#addToCache(action);
        }


        // Mark each season/episode of the show as complete. Somewhat inefficient, but it's not
        // expected for there to be enough purged markers for this to cause any significant slowdown.
        // In theory not necessary, but good to be safe.
        show.forEach(/**@this {PurgedMarkerManager}*/function(/**@type {MarkerAction}*/ markerAction) {
            this.#purgeCache.get(markerAction.parent_id).status = PurgeCacheStatus.Complete;
            this.#purgeCache.get(markerAction.season_id).status = PurgeCacheStatus.Complete;
        }.bind(this));

        show.status = PurgeCacheStatus.Complete;
    }

    /**Return the number of purged markers associated with the given show/season/episode */
    getPurgeCount(metadataId) {
        const item = this.#purgeCache.get(metadataId);
        return item ? item.count : 0;
    }

    /**
     * Add the given marker action to the purge caches.
     * @param {MarkerAction} action */
    #addToCache(action) {
        if (action.show_id == -1) {
            // Movie
            Log.assert(action.movieData, 'Show id of -1 should imply that we have valid MovieData.');
            /** @type {PurgedMovieSection} */
            let section = this.#serverPurgeInfo.getOrAdd(action.section_id, true /*isMovie*/);
            let movie = section.getOrAdd(action.parent_id);
            this.#purgeCache.lazySet(movie.id, movie);
            if (movie.get(action.marker_id)) {
                Log.warn(`PurgedMarkerManager: Attempting to add a marker to the cache that already exists (${action.marker_id})! Overwriting.`);
            }

            movie.addNewMarker(action);

        } else {
            let section = this.#serverPurgeInfo.getOrAdd(action.section_id, false /*isMovie*/);
            let show = section.getOrAdd(action.show_id);
            let season = show.getOrAdd(action.season_id);
            let episode = season.getOrAdd(action.parent_id);
            this.#purgeCache.lazySet(show.id, show);
            this.#purgeCache.lazySet(season.id, season);
            this.#purgeCache.lazySet(episode.id, episode);
            if (episode.get(action.marker_id)) {
                Log.warn(`PurgedMarkerManager: Attempting to add a marker to the cache that already exists (${action.marker_id})! Overwriting.`);
            }
    
            episode.addNewMarker(action);
        }
    }

    /**
     * Callback invoked when a marker or markers are restored or ignored, updating all relevant caches.
     * @param {PurgedSection} purgedSection
     * @param {MarkerData[]} newMarkers */
    onPurgedMarkerAction(purgedSection, newMarkers=null) {
        purgedSection.forEach(/**@this {PurgedMarkerManager}*/function(/**@type {MarkerAction}*/ marker) {
            /** @type {PurgedBaseItem} */
            const baseItem = this.#purgeCache.get(marker.parent_id);
            if (baseItem) {
                baseItem.removeIfPresent(marker.marker_id);
                if (baseItem.count <= 0) { delete this.#purgeCache[marker.parent_id]; }
                if (baseItem instanceof PurgedEpisode) {
                    if (this.#purgeCache.get(marker.season_id).count <= 0) { delete this.#purgeCache[marker.season_id]; }
                    if (this.#purgeCache.get(marker.show_id).count <= 0) { delete this.#purgeCache[marker.show_id]; }
                }
            }
        }.bind(this));

        PlexClientState.GetState().notifyPurgeChange(purgedSection, newMarkers || []);
    }

    /**
     * Invoke the purge overlay for a single show's purged marker(s).
     * @param {number} showId The show of purged markers to display. */
    showSingleShow(showId) {
        let showMarkers = this.#purgeCache.get(showId);
        if (!showMarkers) {
            // Ignore invalid requests
            Log.warn(`PurgedMarkerManager: Called showSingleShow with a show that has no cached purged markers (${showId}). How did that happen?`);
            return;
        }

        this.#showSingle(showMarkers, DisplayType.All);
    }

    /**
     * Invoke the purge overlay for a single season's purged marker(s).
     * @param {number} seasonId The season of purged markers to display. */
    showSingleSeason(seasonId) {
        let seasonMarkers = this.#purgeCache.get(seasonId);
        if (!seasonMarkers) {
            // Ignore invalid requests
            Log.warn(`PurgedMarkerManager: Called showSingleSeason with a season that has no cached purged markers (${seasonId}). How did that happen?`);
            return;
        }

        // Reach into the internals of PurgedGroup to create a minified cache
        let dummyShow = new PurgedShow(seasonMarkers.parent.id);
        dummyShow.addInternal(seasonId, seasonMarkers);

        this.#showSingle(dummyShow, DisplayType.SingleSeason);
    }

    /**
     * Invoke the purge overlay for a singe episode's purged marker(s).
     * @param {number} episodeId The episode of purged markers to display. */
    showSingleEpisode(episodeId) {
        let episodeMarkers = this.#purgeCache.get(episodeId);
        if (!episodeMarkers) {
            // Ignore invalid requests
            Log.warn(`PurgedMarkerManager: Called showSingleEpisode with an episode that has no cached purged markers (${episodeId}). How did that happen?`);
            return;
        }
        // Reach into the internals of PurgedGroup to create a minified cache
        let dummyShow = new PurgedShow(episodeMarkers.parent.parent.id);
        let dummySeason = new PurgedSeason(episodeMarkers.parent.id, dummyShow);
        dummySeason.addInternal(episodeId, episodeMarkers);
        dummyShow.addInternal(dummySeason.id, dummySeason);

        this.#showSingle(dummyShow, DisplayType.SingleEpisode);
    }

    /**
     * Show purged markers for a single movie, initiated through its entry in the search results table.
     *
     * Identical to showSingleShow, but it's clearer than bundling them together.
     * @param {number} movieId */
    showSingleMovie(movieId) {
        let movieMarkers = this.#purgeCache.get(movieId);
        if (!movieMarkers) {
            // Ignore invalid requests
            Log.warn(`PurgedMarkerManager: Called showSingleMovie with a movie that has no cached purged markers (${movieId}). How did that happen?`);
            return;
        }

        this.#showSingle(movieMarkers, DisplayType.All);
    }

    /**
     * Core routine that invokes the right overlay.
     * @param {PurgedShow} purgedItem The purged markers to display.
     * @param {DisplayType} displayType The group of purged markers being displayed. */
    #showSingle(purgedItem, displayType) {
        if (purgedItem.count == 0) {
            return;
        }

        const args = [purgedItem, Overlay.dismiss, displayType];
        const table = purgedItem instanceof PurgedMovie ? new MoviePurgeTable(...args) : new TVPurgeTable(...args);
        const html = appendChildren(buildNode('div', { id : 'purgeContainer' }), table.html());
        Overlay.build({ dismissible : true, closeButton : true }, html);
    }

    /**
     * Callback invoked when we successfully queried for purged markers (regardless of whether we found any).
     * @param {PurgeSection} purgeSection Tree of purged markers in the current library section.
     * @param {boolean} dryRun Whether we just want to populate our cache data, not show the purges. */
    #onMarkersFound(purgeSection, dryRun) {
        if (PlexClientState.GetState().activeSectionType() == SectionType.Movie) {
            for (const [movieId, movie] of Object.entries(purgeSection)) {
                const movieCache = this.#purgeCache.get(movieId);
                if (movieCache && movieCache.status == PurgeCacheStatus.Complete) {
                    Log.tmi(`PurgedMarkerCache::onMarkersFound: Not caching completely cached movie ${movieId}`);
                    continue;
                }

                for (const markerAction of Object.values(movie)) {
                    this.#addToCache(markerAction);
                }

                this.#purgeCache.get(movieId).status = PurgeCacheStatus.Complete;
            }
        } else {
            // TV section
            for (const [showId, show] of Object.entries(purgeSection)) {
                const showCache = this.#purgeCache.get(showId);
                if (showCache && showCache.status == PurgeCacheStatus.Complete) {
                    Log.tmi(`PurgedMarkerCache::onMarkersFound: Not caching completely cached show ${showId}`);
                    continue;
                }
    
                for (const [seasonId, season] of Object.entries(show)) {
                    // If we're here, we shouldn't have anything cached
                    Log.assert(!this.#purgeCache.get(seasonId), `PurgedMarkerCache::onMarkersFound: [!this.#purgeCache.get(seasonId)] - If the season isn't complete, the season shouldn't exist.`);
                    for (const [episodeId, episode] of Object.entries(season)) {
                        for (const markerAction of Object.values(episode)) {
                            this.#addToCache(markerAction);
                        }
                        this.#purgeCache.get(episodeId).status = PurgeCacheStatus.Complete;
                    }
                    this.#purgeCache.get(seasonId).status = PurgeCacheStatus.Complete;
                }
                this.#purgeCache.get(showId).status = PurgeCacheStatus.Complete;
            }
        }

        const activeSection = PlexClientState.GetState().activeSection();
        this.#serverPurgeInfo.getOrAdd(activeSection).status = PurgeCacheStatus.Complete;
        if (dryRun) {
            return;
        }

        new PurgeOverlay(this.#serverPurgeInfo.get(activeSection), activeSection).show();
    }
}

export default PurgedMarkerManager;
