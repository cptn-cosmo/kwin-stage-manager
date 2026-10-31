# Maintainer: cosmo <cosmo@geeks.gay>
pkgname=kwin-stage-manager
pkgver=0.2.2
pkgrel=1
pkgdesc="macOS-style Stage Manager for KWin 6 on Plasma Wayland"
arch=('any')
url="https://git.geeks.gay/cosmo/ksm"
license=('MIT')
depends=('kwin>=6.0' 'qt6-declarative' 'kirigami')
makedepends=('git')
checkdepends=('nodejs')
source=("$pkgname::git+$url.git#tag=v$pkgver")
sha256sums=('SKIP')

check() {
    cd "$pkgname"
    node --test tests/
}

package() {
    cd "$pkgname"
    install -d "$pkgdir/usr/share/kwin/scripts/$pkgname"
    cp -r --no-preserve=ownership package/. "$pkgdir/usr/share/kwin/scripts/$pkgname/"
    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
    install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
}
