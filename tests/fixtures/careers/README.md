# Careers document fixtures

These small documents contain only synthetic CV text. `sample-cv.docx` was
created with python-docx 1.2.0. `sample-cv.doc` and `sample-cv.pdf` were exported
from that document with the installed LibreOffice Writer, using the MS Word 97
and PDF export filters. They exercise actual office file structures, including
compound-file mini streams and normal compressed DOCX metadata.

Malformed ZIP fixtures are generated in the focused test file from the PKWARE
APPNOTE record layout. Tests deliberately alter independent document fixtures
to check rejection of corrupted structures, encryption, macros and size abuse.
