fn main() {
    // The AVIF decoder's x86 assembly refers to Rust symbols directly, which a
    // shared library only allows when its symbols cannot be overridden
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-Bsymbolic");
    }
    tauri_build::build()
}
