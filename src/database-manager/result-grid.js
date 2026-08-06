(function exposeDatabaseResultGrid(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DatabaseResultGrid = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDatabaseResultGridApi() {
  'use strict';

  const DEFAULT_ROW_HEIGHT = 34;
  const DEFAULT_OVERSCAN_ROWS = 8;
  const MAX_RENDER_ROWS = 240;
  const MAX_INSPECTOR_TEXT_LENGTH = 512 * 1024;

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getVisibleRange(input = {}) {
    const rowCount = Math.max(0, Math.floor(finiteNumber(input.rowCount, 0)));
    const rowHeight = Math.max(1, finiteNumber(input.rowHeight, DEFAULT_ROW_HEIGHT));
    const viewportHeight = Math.max(rowHeight, finiteNumber(input.viewportHeight, rowHeight * 10));
    const scrollTop = Math.max(0, finiteNumber(input.scrollTop, 0));
    const overscanRows = Math.max(0, Math.floor(finiteNumber(input.overscanRows, DEFAULT_OVERSCAN_ROWS)));
    if (!rowCount) return Object.freeze({ start: 0, end: 0, topSpacer: 0, bottomSpacer: 0, rowHeight });
    const firstVisible = Math.floor(scrollTop / rowHeight);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / rowHeight);
    const start = Math.max(0, firstVisible - overscanRows);
    const requestedEnd = Math.min(rowCount, lastVisible + overscanRows);
    const end = Math.min(rowCount, start + MAX_RENDER_ROWS, Math.max(start, requestedEnd));
    return Object.freeze({
      start,
      end,
      topSpacer: start * rowHeight,
      bottomSpacer: Math.max(0, (rowCount - end) * rowHeight),
      rowHeight
    });
  }

  function normalizeSelection(input = {}, rowCount = 0, columnCount = 0) {
    const rows = Array.isArray(input.selectedRows) ? input.selectedRows : [];
    const selectedRows = [...new Set(rows
      .map((row) => Number(row))
      .filter((row) => Number.isInteger(row) && row >= 0 && row < rowCount))].sort((a, b) => a - b);
    const rawCell = input.cell && typeof input.cell === 'object' ? input.cell : null;
    const row = Number(rawCell?.row);
    const column = Number(rawCell?.column);
    const cell = Number.isInteger(row) && row >= 0 && row < rowCount && Number.isInteger(column) && column >= 0 && column < columnCount
      ? Object.freeze({ row, column })
      : null;
    return Object.freeze({ selectedRows: Object.freeze(selectedRows), cell });
  }

  function inspectValue(value) {
    if (value === null || value === undefined) {
      return Object.freeze({ kind: 'null', label: 'NULL', display: 'NULL', formatted: 'NULL', byteLength: 0 });
    }
    if (value && typeof value === 'object' && value.type === 'binary') {
      const byteLength = Math.max(0, Number(value.byteLength) || (Array.isArray(value.bytes) ? value.bytes.length : 0));
      const base64 = typeof value.base64 === 'string' ? value.base64 : '';
      const preview = base64 ? base64.slice(0, 160) : Array.isArray(value.bytes) ? value.bytes.slice(0, 64).map((item) => Number(item) & 255).map((item) => item.toString(16).padStart(2, '0')).join(' ') : '';
      return Object.freeze({
        kind: 'binary',
        label: 'BLOB',
        display: `Binary (${byteLength} bytes)`,
        formatted: preview ? `${preview}${preview.length >= 160 ? '...' : ''}` : `Binary (${byteLength} bytes)`,
        byteLength
      });
    }
    if (typeof value === 'object') {
      let formatted;
      try { formatted = JSON.stringify(value, null, 2); } catch { formatted = String(value); }
      if (formatted.length > MAX_INSPECTOR_TEXT_LENGTH) formatted = `${formatted.slice(0, MAX_INSPECTOR_TEXT_LENGTH)}\n... value truncated`;
      return Object.freeze({ kind: 'json', label: 'JSON', display: formatted.replace(/\s+/g, ' ').slice(0, 240), formatted, byteLength: new TextEncoder().encode(formatted).byteLength });
    }
    const kind = typeof value;
    const source = String(value);
    const formatted = source.length > MAX_INSPECTOR_TEXT_LENGTH ? `${source.slice(0, MAX_INSPECTOR_TEXT_LENGTH)}\n... value truncated` : source;
    const display = source.replace(/\s+/g, ' ').slice(0, 240);
    return Object.freeze({ kind, label: kind.toUpperCase(), display, formatted, byteLength: new TextEncoder().encode(source).byteLength });
  }

  function createVirtualizedGrid(options = {}) {
    if (!options.container || typeof options.container.appendChild !== 'function') throw new TypeError('A result grid container is required.');
    const columns = Array.isArray(options.columns) ? options.columns : [];
    const rows = Array.isArray(options.rows) ? options.rows : [];
    const rowHeight = Math.max(1, finiteNumber(options.rowHeight, DEFAULT_ROW_HEIGHT));
    const overscanRows = Math.max(0, Math.floor(finiteNumber(options.overscanRows, DEFAULT_OVERSCAN_ROWS)));
    let selection = normalizeSelection(options.selection, rows.length, columns.length);
    const table = document.createElement('table');
    table.className = 'database-result-grid-table';
    table.setAttribute('aria-rowcount', String(rows.length));
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((column) => {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = String(column?.name ?? '');
      if (column?.dataType) {
        const type = document.createElement('small');
        type.textContent = String(column.dataType);
        cell.appendChild(type);
      }
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    table.append(head, body);
    options.container.replaceChildren(table);

    function makeSpacer(height) {
      const row = document.createElement('tr');
      row.className = 'database-result-grid-spacer';
      row.setAttribute('aria-hidden', 'true');
      const cell = document.createElement('td');
      cell.colSpan = Math.max(1, columns.length);
      cell.style.height = `${Math.max(0, height)}px`;
      row.appendChild(cell);
      return row;
    }

    function isSelectedRow(index) {
      return selection.selectedRows.includes(index);
    }

    function render() {
      const range = getVisibleRange({
        rowCount: rows.length,
        rowHeight,
        overscanRows,
        scrollTop: options.container.scrollTop,
        viewportHeight: options.container.clientHeight
      });
      body.replaceChildren();
      if (range.topSpacer) body.appendChild(makeSpacer(range.topSpacer));
      for (let rowIndex = range.start; rowIndex < range.end; rowIndex += 1) {
        const rowElement = document.createElement('tr');
        rowElement.className = 'database-result-grid-row database-result-data-row';
        rowElement.dataset.resultRowIndex = String(rowIndex);
        rowElement.setAttribute('aria-rowindex', String(rowIndex + 2));
        rowElement.setAttribute('aria-selected', String(isSelectedRow(rowIndex)));
        rowElement.addEventListener('click', (event) => {
          if (event.target.closest('.database-result-grid-cell')) return;
          options.onRowClick?.({ rowIndex, row: rows[rowIndex], event });
        });
        const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
        columns.forEach((_column, columnIndex) => {
          const cellElement = document.createElement('td');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'database-result-grid-cell';
          button.dataset.resultRowIndex = String(rowIndex);
          button.dataset.resultColumnIndex = String(columnIndex);
          const value = row[columnIndex];
          const inspected = inspectValue(value);
          const rendered = options.renderCell?.({ value, rowIndex, columnIndex, inspected }) || { text: inspected.display };
          button.textContent = String(rendered.text ?? inspected.display);
          if (rendered.title) button.title = String(rendered.title);
          button.setAttribute('aria-label', `${String(columns[columnIndex]?.name || `Column ${columnIndex + 1}`)} row ${rowIndex + 1}`);
          if (selection.cell?.row === rowIndex && selection.cell?.column === columnIndex) button.classList.add('selected');
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            options.onCellClick?.({ rowIndex, columnIndex, value, inspected, event });
          });
          cellElement.appendChild(button);
          rowElement.appendChild(cellElement);
        });
        body.appendChild(rowElement);
      }
      if (range.bottomSpacer) body.appendChild(makeSpacer(range.bottomSpacer));
      options.onRender?.({ range, selection });
      return range;
    }

    const onScroll = () => render();
    options.container.addEventListener('scroll', onScroll, { passive: true });
    render();
    return Object.freeze({
      render,
      destroy() {
        options.container.removeEventListener('scroll', onScroll);
        options.container.replaceChildren();
      },
      getSelection() { return selection; },
      setSelection(next) {
        selection = normalizeSelection(next, rows.length, columns.length);
        render();
        return selection;
      },
      scrollToRow(rowIndex) {
        const row = Math.min(Math.max(Number(rowIndex) || 0, 0), Math.max(rows.length - 1, 0));
        options.container.scrollTop = row * rowHeight;
        render();
      }
    });
  }

  return Object.freeze({
    DEFAULT_ROW_HEIGHT,
    DEFAULT_OVERSCAN_ROWS,
    MAX_RENDER_ROWS,
    MAX_INSPECTOR_TEXT_LENGTH,
    getVisibleRange,
    inspectValue,
    normalizeSelection,
    createVirtualizedGrid
  });
});
