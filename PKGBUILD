# Maintainer: Niyaki Pham <niyakipham@gmail.com>
pkgname=nettruyen
pkgver=1.0
pkgrel=1
pkgdesc="Nettruyen doc truyen online"
arch=('x86_64')
license=('GPL')
depends=('qt5-base' 'qt5-tools')
source=("nettruyen-${pkgver}.tar.gz")
sha256sums=('SKIP')

package() {
    mkdir -p ${pkgdir}/usr/share/nettruyen
    echo ${srcdir}

    install -Dm644 ${srcdir}/$pkgname/$pkgname ${pkgdir}/usr/share/licenses/$pkgname
    install -Dm755 ${srcdir}/$pkgname/$pkgname.desktop ${pkgdir}/usr/share/applications/$pkgname.desktop
    install -Dm644 ${srcdir}/$pkgname/icons/$pkgname.png ${pkgdir}/usr/share/pixmaps/$pkgname.png

  # setuid on chrome-sandbox
  chmod u+s "$pkgdir"/usr/share/licenses/$pkgname

}

