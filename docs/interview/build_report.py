"""Build the teaching PDF from its editable Markdown and generated diagrams.

Run from the repository root after generating tmp/pdfs/interview/fixture.json.
Requires reportlab, Pillow, and pypdf. No application source is modified.
"""
from __future__ import annotations

import html
import json
import math
import os
import re
from pathlib import Path

from PIL import Image as PILImage, ImageDraw, ImageFont
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, Image, KeepTogether, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ASSETS = HERE / 'assets'
OUT = ROOT / 'output/pdf/Rasterform_CoreWeave_Teaching_Report.pdf'
TMP = ROOT / 'tmp/pdfs/interview'
FONT_DIRS = [
    Path(os.environ.get('RASTERFORM_REPORT_FONTS', '/nonexistent')),
    Path('/Users/atiliobarreda/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype'),
    Path('/usr/share/fonts/truetype/dejavu'),
    Path('/Library/Fonts'),
]
FONTS = next((p for p in FONT_DIRS if (p / 'DejaVuSans.ttf').is_file()), None)
if FONTS is None:
    raise SystemExit('Set RASTERFORM_REPORT_FONTS to a directory containing DejaVuSans TTF fonts.')

INK = '#242724'
MUTED = '#636D67'
LIME = '#CAEF73'
PALE = '#F1F5EC'
LINE = '#D7DED4'
GREEN = '#356343'

for name, file in [('Body', 'DejaVuSans.ttf'), ('Body-Bold', 'DejaVuSans-Bold.ttf'),
                   ('Body-Italic', 'DejaVuSans-Oblique.ttf'), ('Code', 'DejaVuSansMono.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(FONTS / file)))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body-Italic', boldItalic='Body-Bold')


def font(size: int, bold: bool = False):
    return ImageFont.truetype(str(FONTS / ('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')), size)


def center_text(draw, xy, text, size=29, color=INK, bold=False):
    draw.text(xy, text, font=font(size, bold), fill=color, anchor='mm')


def rounded_box(draw, box, fill=PALE, outline=LINE, radius=20):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=2)


def arrow(draw, start, end, fill=GREEN, width=5):
    draw.line([start, end], fill=fill, width=width)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    length = 14
    wings = [(end[0] - length * math.cos(angle + delta), end[1] - length * math.sin(angle + delta)) for delta in [-0.5, 0.5]]
    draw.polygon([end, *wings], fill=fill)


def make_assets():
    ASSETS.mkdir(parents=True, exist_ok=True)
    fixture = json.loads((TMP / 'fixture.json').read_text())
    w, h = fixture['width'], fixture['height']
    source = PILImage.frombytes('RGBA', (w, h), bytes(fixture['rgba'])).convert('RGB')
    field = PILImage.frombytes('L', (w, h), bytes(round(max(0, min(1, v)) * 255) for v in fixture['values'])).convert('RGB')
    page = PILImage.new('RGB', (1600, 475), 'white')
    draw = ImageDraw.Draw(page)
    for x, label, sub in [(10, 'SOURCE IMAGE', '180 x 135 pixels'), (555, 'LUMINANCE FIELD', 'One value per pixel'), (1100, 'RELIEF GEOMETRY', '64 x 48 grid segments')]:
        center_text(draw, (x + 240, 35), label, 28, bold=True)
        center_text(draw, (x + 240, 76), sub, 24, MUTED)
    page.paste(source.resize((480, 360), PILImage.Resampling.NEAREST), (10, 106))
    page.paste(field.resize((480, 360), PILImage.Resampling.NEAREST), (555, 106))
    arrow(draw, (506, 280), (539, 280))
    arrow(draw, (1052, 280), (1085, 280))
    pos = fixture['positions']
    points = [pos[i:i+3] for i in range(0, len(pos), 3)]
    # A simple orthographic explanatory projection, not the application's renderer.
    projected = [(x - 0.46*y, -0.30*x - 0.66*y - 1.10*z) for x, y, z in points]
    xs, ys = zip(*projected)
    scale = min(480/(max(xs)-min(xs)), 305/(max(ys)-min(ys)))
    screen = [(1100 + (x-min(xs))*scale, 132 + (y-min(ys))*scale) for x,y in projected]
    tris = [fixture['indices'][i:i+3] for i in range(0, len(fixture['indices']), 3)]
    tris.sort(key=lambda tri: sum(points[k][0]*0.1 + points[k][1]*0.9 + points[k][2]*0.4 for k in tri), reverse=True)
    for tri in tris:
        a,b,c = [points[k] for k in tri]
        u = [b[j]-a[j] for j in range(3)]
        v = [c[j]-a[j] for j in range(3)]
        normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        mag = math.sqrt(sum(n*n for n in normal)) or 1
        light = abs(sum(normal[j]*[-0.25, -0.45, 0.86][j] for j in range(3))/mag)
        shade = 0.48 + 0.52*light
        col = tuple(round(sum(fixture['colors'][k*3+j] for k in tri)/3*255*shade) for j in range(3))
        draw.polygon([screen[k] for k in tri], fill=col)
    page.save(ASSETS / 'pipeline-example.png')

    flow = PILImage.new('RGB', (1600, 420), 'white')
    d = ImageDraw.Draw(flow)
    labels = [('Image', 'RGBA pixels'), ('Channels', 'Scalar fields'), ('Compose', 'One height field'), ('Mesh', 'Vertices + UVs'), ('Output', 'Render / asset')]
    for i, (top, sub) in enumerate(labels):
        x = 10 + i*323
        rounded_box(d, (x, 35, x+290, 174), fill=LIME if i==0 else PALE)
        center_text(d, (x+145, 85), top, 36, bold=True)
        center_text(d, (x+145, 134), sub, 24, MUTED)
        if i<4: arrow(d, (x+294, 104), (x+317, 104))
    d.line([(155, 178), (155, 270), (1447, 270), (1447, 184)], fill=GREEN, width=4)
    arrow(d, (1447, 220), (1447, 184))
    rounded_box(d, (380, 230, 1230, 310), fill='white', outline='white')
    center_text(d, (805, 265), 'Retained source bitmap -> portable texture export', 29, GREEN, True)
    center_text(d, (800, 370), 'Height detail and texture detail travel through different paths.', 27, MUTED)
    flow.save(ASSETS / 'data-flow.png')

    proc = PILImage.new('RGB', (1600, 585), 'white')
    d = ImageDraw.Draw(proc)
    rounded_box(d, (15, 25, 480, 260), fill=PALE)
    rounded_box(d, (590, 25, 1070, 260), fill=LIME)
    center_text(d, (248, 76), 'VISIBLE RENDERER', 29, bold=True)
    center_text(d, (248, 131), 'Vue editor + preview', 28)
    center_text(d, (248, 191), 'User intent / status', 25, MUTED)
    center_text(d, (830, 76), 'ELECTRON MAIN', 29, bold=True)
    center_text(d, (830, 131), 'Validate + orchestrate', 28)
    center_text(d, (830, 191), 'Dialogs / cancellation / save', 24, MUTED)
    arrow(d, (486, 142), (580, 142))
    center_text(d, (535, 114), 'IPC', 24, GREEN)
    rounded_box(d, (1150, 25, 1585, 260), fill=PALE)
    center_text(d, (1367, 77), 'FILESYSTEM', 29, bold=True)
    center_text(d, (1367, 133), 'Validate output', 28)
    center_text(d, (1367, 190), 'Commit artifact', 26, MUTED)
    arrow(d, (1077, 142), (1142, 142))
    for box, title, body, small in [((250, 354, 735, 535), 'HIDDEN FINAL RENDERER', 'Browser path tracer', 'Separate sandboxed window'), ((890, 354, 1375, 535), 'BLENDER CHILD PROCESS', 'Cycles / .blend export', 'Private job configuration')]:
        rounded_box(d, box, fill=PALE)
        cx = (box[0]+box[2])/2
        center_text(d, (cx, 396), title, 25, bold=True)
        center_text(d, (cx, 444), body, 28)
        center_text(d, (cx, 493), small, 23, MUTED)
    d.line([(830, 265), (830, 305), (490,305), (490,345)], fill=GREEN, width=4)
    arrow(d, (490,320), (490,345))
    d.line([(830,305), (1133,305), (1133,345)], fill=GREEN, width=4)
    arrow(d, (1133,320), (1133,345))
    center_text(d, (800, 569), 'Process isolation does not isolate GPU time or unified memory.', 24, MUTED)
    proc.save(ASSETS / 'process-boundaries.png')

    life = PILImage.new('RGB', (1600, 390), 'white')
    d = ImageDraw.Draw(life)
    labels = ['Requested', 'Preparing', 'Rendering', 'Validating', 'Saving', 'Succeeded']
    for i,label in enumerate(labels):
        x = 5 + i*268
        rounded_box(d, (x, 45, x+245, 150), fill=LIME if i==5 else PALE)
        center_text(d, (x+122, 98), label, 28, bold=True)
        if i<5: arrow(d, (x+247, 98), (x+264, 98))
    d.line([(392,155),(392,239),(925,239),(925,155)], fill=GREEN, width=3)
    arrow(d, (657,240),(657,274))
    rounded_box(d, (370, 278, 945, 362), fill=PALE)
    center_text(d, (657, 320), 'Failed / cancelled -> cleanup', 27, bold=True)
    center_text(d, (1228, 241), 'Only publish success after', 26, GREEN)
    center_text(d, (1228, 280), 'the artifact is committed.', 26, GREEN, True)
    life.save(ASSETS / 'job-lifecycle.png')


def inline(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r'`([^`]+)`', lambda m: '<font name="Code" size="8.2">'+m.group(1)+'</font>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'<link href="\2" color="#356343"><u>\1</u></link>', text)
    return text


BASE = dict(fontName='Body', fontSize=9.65, leading=13.7, textColor=colors.HexColor(INK), spaceAfter=8)
STYLES = {
    'body': ParagraphStyle('body', **BASE),
    'h1': ParagraphStyle('h1', fontName='Body-Bold', fontSize=45, leading=51, textColor=colors.HexColor(INK), spaceAfter=12),
    'h2': ParagraphStyle('h2', fontName='Body-Bold', fontSize=22, leading=27, textColor=colors.HexColor(INK), spaceBefore=2, spaceAfter=16, keepWithNext=True),
    'h3': ParagraphStyle('h3', fontName='Body-Bold', fontSize=11.5, leading=15.5, textColor=colors.HexColor(GREEN), spaceBefore=8, spaceAfter=7, keepWithNext=True),
    'small': ParagraphStyle('small', fontName='Body', fontSize=8.2, leading=11.3, textColor=colors.HexColor(MUTED), spaceAfter=7),
    'bullet': ParagraphStyle('bullet', **{**BASE, 'leftIndent':12, 'firstLineIndent':-10, 'spaceAfter':6}),
    'table': ParagraphStyle('table', fontName='Body', fontSize=8.5, leading=11.7, textColor=colors.HexColor(INK), spaceAfter=0),
    'tablehead': ParagraphStyle('tablehead', fontName='Body-Bold', fontSize=8.6, leading=11.5, textColor=colors.white, spaceAfter=0),
    'callout': ParagraphStyle('callout', fontName='Body', fontSize=10, leading=14.4, textColor=colors.HexColor(INK), spaceAfter=0),
    'code': ParagraphStyle('code', fontName='Code', fontSize=8.35, leading=12.6, textColor=colors.HexColor(INK), spaceAfter=0),
}


class ReportTemplate(BaseDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and flowable.style.name == 'h2':
            title = flowable.getPlainText()
            key = 'section-' + str(self.page)
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(title, key, 0, False)


def decorate(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor(LIME))
    canvas.rect(48, 749, 32, 4, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor(MUTED))
    canvas.setFont('Body-Bold', 7)
    canvas.drawString(88, 749, 'RASTERFORM / TEACHING CASE STUDY')
    canvas.setFont('Body', 7)
    canvas.drawRightString(564, 749, 'SOURCE SNAPSHOT 7f49da7')
    canvas.setStrokeColor(colors.HexColor(LINE))
    canvas.line(48, 42, 564, 42)
    canvas.setFillColor(colors.HexColor(MUTED))
    canvas.setFont('Body', 7.1)
    canvas.drawString(48, 27, 'Atilio Barreda II / CoreWeave interview preparation')
    canvas.setFont('Body-Bold', 8)
    canvas.drawRightString(564, 27, str(doc.page).zfill(2))
    canvas.restoreState()


def table_block(lines):
    rows = [[c.strip() for c in line.strip().strip('|').split('|')] for line in lines]
    rows = [rows[0], *rows[2:]]
    n = len(rows[0])
    if n == 2:
        widths = [150,354] if rows[0][0] != 'ID' else [42,462]
    elif n == 3:
        if rows[0][0] == 'Time': widths = [70,159,275]
        elif rows[0][0] == 'Finding': widths = [168,146,190]
        elif rows[0][0] == 'Route': widths = [85,248,171]
        elif rows[0][0] == 'Capability': widths = [142,153,209]
        elif rows[0][0] == 'Decision': widths = [120,192,192]
        else: widths = [168,168,168]
    else:
        widths = [504/n]*n
    data = [[Paragraph(inline(cell), STYLES['tablehead' if i==0 else 'table']) for cell in row] for i,row in enumerate(rows)]
    table = Table(data, colWidths=widths, hAlign='LEFT', repeatRows=1)
    table.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),colors.HexColor(INK)),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor(PALE),colors.white]),
        ('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('LINEBELOW',(0,0),(-1,0),0.8,colors.HexColor(INK)),
        ('LINEBELOW',(0,-1),(-1,-1),0.5,colors.HexColor(LINE)),
    ]))
    return [table, Spacer(1,10)]


def boxed(text, style, background=PALE):
    p = Paragraph(text, style)
    t = Table([[p]], colWidths=[504], hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,-1),colors.HexColor(background)),
        ('LINEBEFORE',(0,0),(0,-1),3,colors.HexColor(LIME)),
        ('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),
        ('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10),
    ]))
    return [t,Spacer(1,10)]


def markdown_story(md):
    lines = md.splitlines()
    story = []
    i=0
    while i<len(lines):
        line=lines[i].strip()
        if not line:
            i+=1; continue
        if line=='<!-- page -->':
            while story and isinstance(story[-1], Spacer):
                story.pop()
            story.append(PageBreak()); i+=1; continue
        if line.startswith('```'):
            block=[]; i+=1
            while i<len(lines) and not lines[i].startswith('```'):
                block.append(html.escape(lines[i]).replace(' ', '&nbsp;')); i+=1
            story.extend(boxed('<br/>'.join(block), STYLES['code'])); i+=1; continue
        if line.startswith('|'):
            block=[]
            while i<len(lines) and lines[i].lstrip().startswith('|'):
                block.append(lines[i]); i+=1
            story.extend(table_block(block)); continue
        m=re.match(r'!\[([^]]*)\]\(([^)]+)\)',line)
        if m:
            path=HERE/m.group(2)
            with PILImage.open(path) as im: w,h=im.size
            story.append(Image(str(path), width=504, height=504*h/w, hAlign='LEFT'))
            story.append(Spacer(1,10)); i+=1; continue
        if line.startswith('> '):
            story.extend(boxed(inline(line[2:]), STYLES['callout'])); i+=1; continue
        matched=False
        for prefix, name in [('### ','h3'),('## ','h2'),('# ','h1')]:
            if line.startswith(prefix):
                story.append(Paragraph(inline(line[len(prefix):]), STYLES[name])); i+=1; matched=True; break
        if matched: continue
        if line.startswith('- '):
            story.append(Paragraph('&#8226;&nbsp; '+inline(line[2:]), STYLES['bullet'])); i+=1; continue
        if re.match(r'^\d+\. ',line):
            story.append(Paragraph(inline(line), STYLES['bullet'])); i+=1; continue
        block=[line]; i+=1
        while i<len(lines) and lines[i].strip() and not lines[i].startswith(('##','<!--','|','>','![','```','- ')):
            block.append(lines[i].strip()); i+=1
        text=' '.join(block)
        small=text.startswith(('Source basis:', 'Paths are relative', 'The figure uses', 'External sources were consulted'))
        story.append(Paragraph(inline(text), STYLES['small' if small else 'body']))
    while story and isinstance(story[-1], Spacer):
        story.pop()
    return story


def main():
    TMP.mkdir(parents=True,exist_ok=True)
    OUT.parent.mkdir(parents=True,exist_ok=True)
    make_assets()
    md=(HERE/'RASTERFORM_TEACHING_REPORT.md').read_text()
    # A page boundary in the source is intentional; unexpected flow is a QA failure.
    expected=md.count('<!-- page -->')+1
    doc=ReportTemplate(str(OUT), pagesize=(612,792), leftMargin=48, rightMargin=48, topMargin=67, bottomMargin=54,
        title='Rasterform: From pixels to reliable GPU-rendered assets', author='Atilio Barreda II',
        subject='Technical teaching case study and CoreWeave interview preparation', pageCompression=1)
    frame=Frame(48,54,516,671,id='body',leftPadding=6,rightPadding=6,topPadding=0,bottomPadding=0)
    doc.addPageTemplates(PageTemplate(id='report',frames=[frame],onPage=decorate))
    doc.build(markdown_story(md))
    reader=PdfReader(OUT)
    print(f'{OUT}: {len(reader.pages)} pages; source sections: {expected}')
    for n,page in enumerate(reader.pages,1):
        text=page.extract_text()
        if not text or '\ufffd' in text or '\u25a0' in text:
            raise AssertionError(f'Missing or broken text on page {n}')
        # Record every page for layout QA without mixing it into the deliverable.
    (TMP/'extracted.txt').write_text('\n\n'.join(f'PAGE {i+1}\n{p.extract_text()}' for i,p in enumerate(reader.pages)))
    assert len(reader.pages)==expected, 'Unexpected pagination; inspect and adjust before delivery.'


if __name__=='__main__':
    main()
