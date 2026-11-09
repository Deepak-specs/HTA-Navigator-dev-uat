"""Entry point:  python run_ingest.py --help"""
import sys

from hta_ingest.pipeline import main

if __name__ == "__main__":
    sys.exit(main())
