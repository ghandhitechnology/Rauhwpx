//! CFB 의 metadata (sector size, CLSID, version, stream list) 로 fixture 구분 가능 여부 확인.

use cfb::CompoundFile;
use std::io::Cursor;

fn inspect_cfb(path: &str) {
    let bytes = std::fs::read(path).unwrap();

    // CFB header raw fields (offset 26~)
    let minor_ver = u16::from_le_bytes([bytes[24], bytes[25]]);
    let major_ver = u16::from_le_bytes([bytes[26], bytes[27]]);
    let byte_order = u16::from_le_bytes([bytes[28], bytes[29]]);
    let sector_shift = u16::from_le_bytes([bytes[30], bytes[31]]);
    let mini_sector_shift = u16::from_le_bytes([bytes[32], bytes[33]]);

    eprintln!("\n=== {} ===", path);
    eprintln!(
        "  CFB ver={}.{} byte_order=0x{:04x} sector_shift=2^{} mini_shift=2^{}",
        major_ver, minor_ver, byte_order, sector_shift, mini_sector_shift
    );

    let cfb = CompoundFile::open(Cursor::new(&bytes)).unwrap();
    // Root entry CLSID
    if let Ok(entry) = cfb.entry("/") {
        eprintln!("  root CLSID = {:?}", entry.clsid());
    }

    // Stream list
    let mut streams: Vec<String> = Vec::new();
    fn walk(cfb: &CompoundFile<Cursor<&Vec<u8>>>, path: &str, out: &mut Vec<String>) {
        if let Ok(entries) = cfb.read_storage(path) {
            for e in entries {
                let p = if path == "/" {
                    format!("/{}", e.name())
                } else {
                    format!("{}/{}", path, e.name())
                };
                if e.is_storage() {
                    walk(cfb, &p, out);
                } else {
                    out.push(format!("{} (size={})", p, e.len()));
                }
            }
        }
    }
    walk(&cfb, "/", &mut streams);
    eprintln!("  streams ({}):", streams.len());
    for s in &streams {
        eprintln!("    {}", s);
    }
}

#[test]
fn check_cfb_metadata() {
    for f in [
        "samples/hwp3-sample16-hwp5.hwp",
        "samples/hwp3-sample16-hwp5-2010.hwp",
        "samples/hwp3-sample16-hwp5-2018.hwp",
        "samples/hwp3-sample16-hwp5-2022.hwp",
        "samples/hwp3-sample16-hwp5-2024.hwp",
    ]
    .iter()
    {
        inspect_cfb(f);
    }
}
