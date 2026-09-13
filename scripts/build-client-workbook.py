#!/usr/bin/env python3
"""Builds the workbook UpCell sends the client to fill in.

    node scripts/catalogue-audit.js --csv     # writes the CSVs this reads
    python scripts/build-client-workbook.py

Reads reports/upcell-catalogue-<date>.csv and reports/pricing-groups.json, and
writes reports/UpCell-Product-Details-<date>.xlsx.

Five sheets, in the order somebody actually works through them:

  Start here        what this is, and what the colours mean
  Fill in           one row per device, with the blanks highlighted
  Pricing decision  the 206 groups where condition is not in the price
  All products      every row and every field, for reference
  What is missing   the counts, so the size of the job is visible

Yellow means "we need this from you". Everything else is what UpCell already
holds and is there so the client can recognise the row.
"""

import csv
import json
import pathlib
from collections import Counter
from datetime import date

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

REPORTS = pathlib.Path(__file__).resolve().parent.parent / "reports"
STAMP = date.today().isoformat()

# --- house style ------------------------------------------------------------
FONT = "Arial"
RED = "D90B0F"          # UpCell brand red. An accent, never a fill.
NEAR_BLACK = "0C0C0C"
OFF_WHITE = "EDEDED"

HEAD = PatternFill("solid", fgColor=NEAR_BLACK)
HEAD_FONT = Font(name=FONT, bold=True, color="FFFFFF", size=10)
# The one colour that means "type here". Used nowhere else, so it cannot be
# mistaken for decoration.
NEEDED = PatternFill("solid", fgColor="FFF2CC")
EXAMPLE = PatternFill("solid", fgColor="E8F4EA")
THIN = Side(style="thin", color="D0D0D0")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def read_catalogue():
    matches = sorted(REPORTS.glob("upcell-catalogue-*.csv"))
    if not matches:
        raise SystemExit("No catalogue CSV. Run: node scripts/catalogue-audit.js --csv")
    with matches[-1].open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_pricing():
    path = REPORTS / "pricing-groups.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def write_row(sheet, row, values):
    """Writes one row at an explicit index.

    Deliberately not sheet.append(). append() writes after max_row, and reading
    or styling any cell extends max_row — so styling a header before appending
    data silently shifts every row down by one. That is what put the example
    row in row 3 and the first real product in row 4.
    """
    for index, value in enumerate(values, start=1):
        sheet.cell(row=row, column=index, value=value)


def style_header(sheet, row=1, freeze=True):
    for cell in sheet[row]:
        if cell.value is None:
            continue
        cell.fill = HEAD
        cell.font = HEAD_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    sheet.row_dimensions[row].height = 30
    # Set last, and by string, so it cannot create a row.
    if freeze:
        sheet.freeze_panes = f"A{row + 1}"


def set_widths(sheet, widths):
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width


# ---------------------------------------------------------------------------

def sheet_start_here(book, rows, pricing):
    sheet = book.active
    sheet.title = "Start here"
    set_widths(sheet, [4, 58, 62])

    def line(row, left, right="", bold=False, size=11, colour=NEAR_BLACK):
        a = sheet.cell(row=row, column=2, value=left)
        a.font = Font(name=FONT, bold=bold, size=size, color=colour)
        a.alignment = Alignment(wrap_text=True, vertical="top")
        if right:
            b = sheet.cell(row=row, column=3, value=right)
            b.font = Font(name=FONT, size=size)
            b.alignment = Alignment(wrap_text=True, vertical="top")

    line(2, "UpCell — product details we need from you", size=16, bold=True, colour=RED)
    line(3, f"Prepared {date.today().strftime('%d %B %Y')} · {len(rows)} products in the catalogue")

    line(5, "What this is", size=13, bold=True)
    line(6, "Every product on the UpCell site, with everything the system already knows "
            "about it. Most of it is filled in. A few things it cannot know without you, "
            "and those are the yellow cells.")

    line(8, "What we need", size=13, bold=True)
    needs = Counter()
    for row in rows:
        for item in (row.get("Needs from client") or "").split(";"):
            item = item.strip()
            if item:
                needs[item] += 1

    labels = {
        "real photo": "A real photo of the actual unit — right now these share one picture per model",
        "IMEI or serial": "The IMEI (phones) or serial number (iPad, Mac) off each device",
        "battery %": "Battery health percentage, from Settings → Battery → Battery Health",
        "description": "A short product description",
        "photo": "Any photo at all",
        "price": "A price",
        "storage": "Storage size",
        "colour": "Colour",
        "grade": "Condition grade",
        "carrier": "Carrier status",
        "device type": "Device type",
        "check price": "A second look at the price",
        "check discount": "A second look at the discount",
    }

    row_at = 9
    for item, count in needs.most_common():
        line(row_at, f"    {labels.get(item, item)}", f"{count} products")
        row_at += 1

    row_at += 1
    line(row_at, "Also: a pricing decision", size=13, bold=True)
    row_at += 1
    line(row_at, f"{len(pricing)} model-and-storage combinations hold units in more than one "
                 "condition, and every unit is priced the same. A Good phone at the same price "
                 "as an Excellent one means one of the two is wrong. See the "
                 "'Pricing decision' tab.")

    row_at += 2
    line(row_at, "How to fill it in", size=13, bold=True)
    row_at += 1
    for text in [
        "Work on the 'Fill in' tab. It has only the products that need something.",
        "Yellow cells are the ones to type in. Please leave the other columns alone — "
        "we match your row back to ours on the Product ID in column A.",
        "Condition and Carrier are dropdowns. Please pick from the list rather than typing.",
        "Row 2 is a filled-in example, in green. Delete it before sending back, or leave "
        "it — we skip it either way.",
        "Photos: put the file name in the Photo column and send the images in one folder "
        "or a shared link. Name each file the Product ID so we can match them.",
        "Send it back as a spreadsheet or a Google Sheets link. Either is fine.",
    ]:
        line(row_at, f"    •  {text}")
        row_at += 1

    row_at += 1
    line(row_at, "What the colours mean", size=13, bold=True)
    row_at += 1
    for fill, text in [(NEEDED, "We need this from you"),
                       (EXAMPLE, "An example, not real data"),
                       (None, "Already in the system — for reference only")]:
        cell = sheet.cell(row=row_at, column=2, value="")
        if fill:
            cell.fill = fill
        cell.border = BOX
        sheet.cell(row=row_at, column=3, value=text).font = Font(name=FONT, size=11)
        row_at += 1

    row_at += 1
    line(row_at, "Questions", size=13, bold=True)
    row_at += 1
    line(row_at, "Reply to whoever sent you this. Nothing here is urgent enough to guess at — "
                 "a wrong IMEI is worse than a blank one, because a blank one is obviously "
                 "missing and a wrong one looks finished.")


def sheet_fill_in(book, rows):
    """One row per product that needs something, blanks highlighted."""
    sheet = book.create_sheet("Fill in")

    columns = [
        ("Product ID", 26, False),
        ("Category", 16, False),
        ("Product", 22, False),
        ("Storage", 10, False),
        ("Colour", 16, False),
        ("Price (USD)", 12, False),
        ("Condition grade", 16, True),
        ("Battery %", 11, True),
        ("IMEI", 20, True),
        ("Serial number", 18, True),
        ("Photo file name", 22, True),
        ("Description", 42, True),
        ("Your notes", 30, True),
    ]

    write_row(sheet, 1, [name for name, _, _ in columns])
    set_widths(sheet, [width for _, width, _ in columns])

    # One example row, so the expected format is not a guess.
    example = ["(example — delete or ignore)", "iPhone", "iPhone 15 Pro", "256GB", "Blue Titanium",
               999, "EXCELLENT", 96, "351234567890123", "", "351234567890123.jpg",
               "Unlocked, boxed with cable. Barely used.", "Screen protector already applied"]
    write_row(sheet, 2, example)
    for index in range(1, len(columns) + 1):
        cell = sheet.cell(row=2, column=index)
        cell.fill = EXAMPLE
        cell.font = Font(name=FONT, size=10, italic=True)
        cell.border = BOX

    needed_columns = [i for i, (_, _, need) in enumerate(columns, start=1) if need]

    wanted = [r for r in rows if (r.get("Needs from client") or "").strip()]
    for offset, row in enumerate(wanted):
        write_row(sheet, 3 + offset, [
            row["Product ID"], row["Category"], row["Product"], row["Storage"], row["Colour"],
            float(row["Price (USD)"]) if row["Price (USD)"] else None,
            row["Condition grade"], row["Battery %"], row["IMEI"], row["Serial number"],
            "", row["Description"], "",
        ])

    style_header(sheet)

    for excel_row in range(3, sheet.max_row + 1):
        for index in range(1, len(columns) + 1):
            cell = sheet.cell(row=excel_row, column=index)
            cell.font = Font(name=FONT, size=10)
            cell.border = BOX
            # Yellow only where it is genuinely empty. Highlighting a cell that
            # already has the answer asks somebody to redo work.
            if index in needed_columns and (cell.value is None or str(cell.value).strip() == ""):
                cell.fill = NEEDED
        sheet.cell(row=excel_row, column=1).font = Font(name=FONT, size=9, color="808080")

    # Dropdowns rather than free text: a grade typed "Excelent" is a row
    # somebody has to chase.
    grade = DataValidation(type="list", formula1='"EXCELLENT,GOOD,FAIR,FAIL"', allow_blank=True,
                           showErrorMessage=True, errorTitle="Pick from the list",
                           error="Choose EXCELLENT, GOOD, FAIR or FAIL.")
    battery = DataValidation(type="whole", operator="between", formula1=0, formula2=100,
                              allow_blank=True, showErrorMessage=True, errorTitle="0 to 100",
                              error="Battery health is a percentage between 0 and 100.")
    sheet.add_data_validation(grade)
    sheet.add_data_validation(battery)
    last = sheet.max_row
    grade.add(f"G3:G{last}")
    battery.add(f"H3:H{last}")

    sheet.auto_filter.ref = f"A1:M{last}"
    return len(wanted)


def sheet_pricing(book, pricing):
    sheet = book.create_sheet("Pricing decision")

    note = sheet.cell(row=1, column=1,
                      value="Each row below holds units in more than one condition, all at the "
                            "same price. Please give us a price per condition — or tell us the "
                            "single price is deliberate and we will leave it.")
    note.font = Font(name=FONT, size=11, bold=True, color=RED)
    note.alignment = Alignment(wrap_text=True, vertical="center")
    sheet.merge_cells("A1:J1")
    sheet.row_dimensions[1].height = 42

    headers = ["Category", "Product", "Storage", "Price now", "Units",
               "Excellent", "Good", "Fair",
               "Excellent should be", "Good should be"]
    write_row(sheet, 2, headers)
    set_widths(sheet, [16, 24, 10, 12, 8, 11, 8, 8, 18, 16])

    for offset, group in enumerate(pricing):
        write_row(sheet, 3 + offset, [
            group["category"], group["product"], group["storage"],
            group["currentPrice"], group["units"],
            group["excellent"], group["good"], group["fair"], None, None,
        ])

    style_header(sheet, row=2)

    for excel_row in range(3, sheet.max_row + 1):
        for index in range(1, len(headers) + 1):
            cell = sheet.cell(row=excel_row, column=index)
            cell.font = Font(name=FONT, size=10)
            cell.border = BOX
            if index in (4, 9, 10):
                cell.number_format = "$#,##0"
            if index in (9, 10):
                cell.fill = NEEDED

    sheet.auto_filter.ref = f"A2:J{sheet.max_row}"


def sheet_all(book, rows):
    sheet = book.create_sheet("All products")
    columns = list(rows[0].keys())
    write_row(sheet, 1, columns)

    widths = {"Product ID": 26, "Description": 44, "Needs from client": 28,
              "Price note": 30, "Product": 22, "Category": 16}
    set_widths(sheet, [widths.get(name, 13) for name in columns])

    numeric = {"Price (USD)", "Discount price", "Original price", "Battery %"}
    for offset, row in enumerate(rows):
        write_row(sheet, 2 + offset, [
            float(row[name]) if name in numeric and row[name] else row[name]
            for name in columns
        ])

    style_header(sheet)

    for excel_row in range(2, sheet.max_row + 1):
        for index in range(1, len(columns) + 1):
            sheet.cell(row=excel_row, column=index).font = Font(name=FONT, size=9)

    sheet.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{sheet.max_row}"


def sheet_missing(book, rows, pricing):
    sheet = book.create_sheet("What is missing")
    write_row(sheet, 1, ["What", "How many products", "Share of catalogue"])
    set_widths(sheet, [52, 20, 20])
    style_header(sheet)

    total = len(rows)
    counts = Counter()
    for row in rows:
        for item in (row.get("Needs from client") or "").split(";"):
            item = item.strip()
            if item:
                counts[item] += 1

    readable = {
        "real photo": "Only a stand-in photo (shares one picture per model)",
        "IMEI or serial": "No IMEI or serial number",
        "battery %": "No battery health reading",
        "description": "No product description",
        "photo": "No photo at all",
        "price": "No price",
        "check price": "Price worth a second look",
        "check discount": "Discount worth a second look",
    }

    ordered = counts.most_common()

    # The total goes in first, at a known row, so the percentages can point at
    # the cell rather than bake the number in. A hardcoded 956 in four formulas
    # is four things to change when the catalogue grows.
    total_row = 2 + len(ordered) + 3
    sheet.cell(row=total_row, column=1, value="Products in the catalogue").font = Font(
        name=FONT, size=10, bold=True)
    sheet.cell(row=total_row, column=2, value=total)

    for offset, (item, count) in enumerate(ordered):
        row_at = 2 + offset
        sheet.cell(row=row_at, column=1, value=readable.get(item, item))
        sheet.cell(row=row_at, column=2, value=count)
        # A formula rather than a computed percentage, so the sheet still reads
        # correctly if somebody edits a count.
        cell = sheet.cell(row=row_at, column=3, value=f"=B{row_at}/$B${total_row}")
        cell.number_format = "0%"

    groups_row = 2 + len(ordered) + 1
    sheet.cell(row=groups_row, column=1,
               value="Model+storage groups pricing every condition the same").font = Font(
        name=FONT, size=10, bold=True)
    sheet.cell(row=groups_row, column=2, value=len(pricing))

    for excel_row in range(2, sheet.max_row + 1):
        for index in range(1, 4):
            cell = sheet.cell(row=excel_row, column=index)
            if cell.font.size != 10 or not cell.font.bold:
                cell.font = Font(name=FONT, size=10)
            cell.border = BOX


def main():
    rows = read_catalogue()
    pricing = read_pricing()

    book = Workbook()
    sheet_start_here(book, rows, pricing)
    filled = sheet_fill_in(book, rows)
    sheet_pricing(book, pricing)
    sheet_all(book, rows)
    sheet_missing(book, rows, pricing)

    out = REPORTS / f"UpCell-Product-Details-{STAMP}.xlsx"
    book.save(out)
    print(f"{out}")
    print(f"  Fill in        {filled} products")
    print(f"  Pricing        {len(pricing)} groups")
    print(f"  All products   {len(rows)} rows")


if __name__ == "__main__":
    main()
