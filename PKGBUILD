# Maintainer: cosmo <cosmo@geeks.gay>
pkgname=kwin-stage-manager
pkgver=0.2.2
pkgrel=1
pkgdesc="macOS-style Stage Manager for KWin 6 on Plasma Wayland"
arch=('any')
url="https://github.com/cptn-cosmo/kwin-stage-manager"
license=('MIT')
depends=('kwin>=6.0' 'qt6-declarative' 'kirigami')
checkdepends=('nodejs')
source=("$pkgname-$pkgver.tar.gz::$url/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('73dd92d7c0b0696dc012730c80fc9feb89e85fdb80759bc863c056dcfb8ebde4')

check() {
    cd "$pkgname-$pkgver"
    node --test tests/
}

package() {
    cd "$pkgname-$pkgver"
    install -d "$pkgdir/usr/share/kwin/scripts/$pkgname"
    cp -r --no-preserve=ownership package/. "$pkgdir/usr/share/kwin/scripts/$pkgname/"
    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
    install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
}
