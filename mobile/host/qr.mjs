import { execFileSync } from 'node:child_process';

// macOS draws the QR code itself (Core Image's CIQRCodeGenerator), so the host needs no package for it.
// The text goes in on stdin, not the command line, where other processes could read it.
const script = `
ObjC.import('CoreImage');
ObjC.import('AppKit');
function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const filter = $.CIFilter.filterWithName('CIQRCodeGenerator');
  filter.setValueForKey(data, 'inputMessage');
  filter.setValueForKey($('M'), 'inputCorrectionLevel');
  const bitmap = $.NSBitmapImageRep.alloc.initWithCIImage(filter.outputImage);
  const rows = [];
  for (let y = 0; y < bitmap.pixelsHigh; y += 1) {
    let row = '';
    for (let x = 0; x < bitmap.pixelsWide; x += 1) row += bitmap.colorAtXY(x, y).brightnessComponent < 0.5 ? '1' : '0';
    rows.push(row);
  }
  return rows.join('\\n');
}`;

/** The QR code for `text` as terminal lines: black on white whatever the terminal's colours, two modules to a character. */
export function qrLines(text) {
  const modules = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { input: text, encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => [...row].map((cell) => cell === '1'));
  // A quiet margin of two modules on every side, which scanners need.
  const width = modules[0].length + 4;
  const blank = Array(width).fill(false);
  const grid = [blank, blank, ...modules.map((row) => [false, false, ...row, false, false]), blank, blank];
  if (grid.length % 2) grid.push(blank);
  const lines = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    for (let x = 0; x < width; x += 1) {
      const top = grid[y][x], bottom = grid[y + 1][x];
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines;
}
