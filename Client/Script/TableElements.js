import { appendChildren, buildNode, msToHms } from './Common.js';

import * as DateUtil from './DateUtil.js';
import { ClientSettings } from './ClientSettings.js';
import Tooltip from './Tooltip.js';


/** @typedef {!import('../../Shared/PlexTypes').MarkerData} MarkerData */

/** A custom object for {@linkcode TableElements.rawTableRow} to parse that will attach the given properties to the column. */
class CustomClassColumn {
    /** @type {string} */
    value;
    /** @type {{key : string, string}} */
    properties;
    constructor(value, properties) {
        this.value = value;
        this.properties = properties;
    }
}

/**
 * Static helper class for creating various elements of a marker table.
 */
class TableElements {

    /**
     * Creates a "free-form" table row using the list of columns to add
     * @param {...[string|HTMLElement|CustomClassColumn]} tds The list of columns to add to the table row.
     */
    static rawTableRow(...tds) {
        const tr = buildNode('tr');
        for (const td of tds) {
            if (td instanceof CustomClassColumn) {
                tr.appendChild(buildNode('td', td.properties, td.value));
            } else {
                tr.appendChild(buildNode('td', {}, td));
            }
        }

        return tr;
    }

    /**
     * Return a custom object for rawTableRow to parse that will center the given column.
     * @param {string} value The text of the column. */
    static centeredColumn(value) {
        return TableElements.customClassColumn(value, 'centeredColumn');
    }

    /**
     * Return a custom object for rawTableRow to parse, including properties to apply to start/end time columns.
     * @param {string} value The text of the column. */
    static timeColumn(value) {
        // Avoid some of the jerkiness of the width used by thumbnails by making
        // time input fields wider across the board if thumbnails are enabled.
        const className = ClientSettings.useThumbnails() ? 'thumbnailEnabledTimeColumn' : 'timeColumn';
        return TableElements.customClassColumn(value, className);
    }

    /** Returns a time column that doesn't take thumbnails into consideration. */
    static shortTimeColumn(value) {
        return TableElements.customClassColumn(value, 'shortTimeColumn');
    }

    /**
     * Returns a column with a fixed width and centered contents.
     * @param {string} value The text of the column. */
    static dateColumn(value) {
        return TableElements.customClassColumn(value, 'centeredColumn timeColumn');
    }

    /**
     * Return a column with a fixed width and centered contents.
     * @param {string} value The text of the column. */
    static optionsColumn(value) {
        return TableElements.customClassColumn(value, 'optionsColumn centeredColumn');
    }

    /** Returns a spanning table row indicating an episode has no existing markers. */
    static noMarkerRow() {
        return TableElements.spanningTableRow('No markers found');
    }

    /**
     * Returns a span of [hh:]mm:ss.000 data, with hover text of the equivalent milliseconds.
     * @param {number} offset The offset, in milliseconds. */
    static timeData(time) {
        return buildNode('span', { title : time }, msToHms(time));
    }

    /**
     * Return a span that contains a "friendly" date (x [time span] ago), with a tooltip of the exact date.
     * @param {MarkerData} marker The marker being displayed. */
    static friendlyDate(marker) {
        const createDate = DateUtil.getDisplayDate(marker.createDate * 1000); // Seconds to ms
        const userModified = marker.modifiedDate !== null || marker.createdByUser;
        const node = buildNode('span', { class : userModified ? 'userModifiedMarker' : '' }, createDate);
        Tooltip.setTooltip(node, TableElements.#dateTooltip(marker));
        return node;
    }

    /**
     * Create a table row that spans the entire length of the table.
     * @param {string|HTMLElement} column The content of the column. */
    static spanningTableRow(content) {
        return appendChildren(buildNode('tr'), buildNode('td', { colspan : 5, class : 'spanningTableRow' }, content));
    }

    /**
     * Return an object for rawTableRow to parse that will attach the given class name(s) to the column.
     * @param {string} value The text for the column.
     * @param {string} className The class name for the column.
     * @returns {CustomClassColumn} */
    static customClassColumn(value, className) {
        return new CustomClassColumn(value, { class : className });
    }

    /**
     * Creates a tooltip for a friendly date, which includes the create date and the last edited date (if any).
     * @param {MarkerData} marker */
    static #dateTooltip(marker) {
        const fullCreateDate = DateUtil.getFullDate(marker.createDate * 1000); // s to ms
        const tooltip = appendChildren(buildNode('span', { class : 'smallerTooltip' }),
            buildNode('span', {}, `${marker.createdByUser ? 'Manually added' : 'Automatically created'} on ${fullCreateDate}`));
        if (marker.modifiedDate !== null) {
            appendChildren(tooltip,
                buildNode('br'),
                buildNode('span', {}, `Last modified on ${DateUtil.getFullDate(marker.modifiedDate * 1000)}`));
        }

        return tooltip;
    }
}

export default TableElements;
