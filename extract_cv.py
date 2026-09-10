import sys, subprocess, tempfile, os, json
import pymupdf

source, binary, language = sys.argv[1:4]
pages, errors = [], []
with tempfile.TemporaryDirectory(prefix='rrhh-read-') as folder:
    doc = pymupdf.open(source)
    if len(doc) > 40:
        raise ValueError('Lectura limitada a 40 páginas; el original sigue disponible')
    for index, page in enumerate(doc):
        text = page.get_text() if doc.is_pdf else ''
        method = 'texto nativo'
        native_text = text
        # PDF mixto: OCR también si la página contiene una imagen grande junto al texto.
        images = page.get_images() if doc.is_pdf else []
        needs_ocr = len(text.strip()) < 40 or bool(images)
        if needs_ocr:
            try:
                target = os.path.join(folder, f'{index}.png')
                page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(target)
                output = subprocess.run([binary, target, 'stdout', '-l', language], capture_output=True, timeout=50, check=True)
                ocr = output.stdout.decode('utf-8', errors='replace')
                if len(ocr.strip()) >= len(text.strip()): text, method = ocr, 'OCR local'
                elif ocr.strip(): text, method = text + '\n\n' + ocr, 'Texto nativo y OCR local'
            except Exception as exc:
                errors.append(f'Página {index+1}: OCR pendiente ({type(exc).__name__})')
        pages.append({'page': index+1, 'text': text, 'nativeText': native_text, 'method': method})
print(json.dumps({'pages': pages, 'errors': errors}, ensure_ascii=True))
