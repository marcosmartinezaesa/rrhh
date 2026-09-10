import sys, subprocess, tempfile, os
import pymupdf

source, binary, language = sys.argv[1:4]
with tempfile.TemporaryDirectory(prefix='rrhh-ocr-') as folder:
    paths = [source]
    if source.lower().endswith('.pdf'):
        doc = pymupdf.open(source)
        if len(doc) > 20:
            raise ValueError('OCR limitado a 20 páginas por CV')
        paths = []
        for i, page in enumerate(doc):
            target = os.path.join(folder, f'{i}.png')
            page.get_pixmap(matrix=pymupdf.Matrix(2,2)).save(target)
            paths.append(target)
    for path in paths:
        result = subprocess.run([binary,path,'stdout','-l',language],capture_output=True,check=True)
        sys.stdout.buffer.write(result.stdout + b'\n')
