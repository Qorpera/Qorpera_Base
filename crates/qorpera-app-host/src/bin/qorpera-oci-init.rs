use serde::Deserialize;
use std::env;
use std::fs;
use std::path::Path;
use std::process;
#[cfg(not(unix))]
use std::process::Command;

#[derive(Debug, Default, Deserialize)]
struct OciInitSpec {
    #[serde(default)]
    entrypoint: Vec<String>,
    #[serde(default)]
    cmd: Vec<String>,
    #[serde(default)]
    workdir: String,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    user: String,
}

#[cfg(target_os = "linux")]
mod linux_net {
    use std::fs;
    use std::mem;
    use std::net::Ipv4Addr;
    use std::time::{SystemTime, UNIX_EPOCH};

    const DHCP_MAGIC: [u8; 4] = [99, 130, 83, 99];
    const DHCP_DISCOVER: u8 = 1;
    const DHCP_OFFER: u8 = 2;
    const DHCP_REQUEST: u8 = 3;
    const DHCP_ACK: u8 = 5;

    struct DhcpLease {
        ip: Ipv4Addr,
        mask: Ipv4Addr,
        router: Option<Ipv4Addr>,
        dns: Vec<Ipv4Addr>,
    }

    fn make_ifreq(ifname: &str) -> libc::ifreq {
        let mut req: libc::ifreq = unsafe { mem::zeroed() };
        let bytes = ifname.as_bytes();
        let copy_len = bytes.len().min(libc::IFNAMSIZ - 1);
        for (i, b) in bytes[..copy_len].iter().enumerate() {
            req.ifr_name[i] = *b as libc::c_char;
        }
        req
    }

    fn make_sockaddr_in(ip: Ipv4Addr) -> libc::sockaddr {
        let mut sin: libc::sockaddr_in = unsafe { mem::zeroed() };
        sin.sin_family = libc::AF_INET as libc::sa_family_t;
        sin.sin_addr = libc::in_addr {
            s_addr: u32::from_ne_bytes(ip.octets()),
        };
        unsafe { mem::transmute_copy(&sin) }
    }

    fn bring_interface_up(sock_fd: libc::c_int, ifname: &str) -> bool {
        let mut req = make_ifreq(ifname);
        if unsafe { libc::ioctl(sock_fd, libc::SIOCGIFFLAGS as _, &mut req) } != 0 {
            return false;
        }
        unsafe {
            req.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
            libc::ioctl(sock_fd, libc::SIOCSIFFLAGS as _, &mut req) == 0
        }
    }

    fn get_mac(sock_fd: libc::c_int, ifname: &str) -> Option<[u8; 6]> {
        let mut req = make_ifreq(ifname);
        if unsafe { libc::ioctl(sock_fd, libc::SIOCGIFHWADDR as _, &mut req) } != 0 {
            return None;
        }
        let mut mac = [0u8; 6];
        unsafe {
            for (i, slot) in mac.iter_mut().enumerate() {
                *slot = req.ifr_ifru.ifru_hwaddr.sa_data[i] as u8;
            }
        }
        Some(mac)
    }

    fn build_dhcp_packet(
        xid: u32,
        mac: [u8; 6],
        msg_type: u8,
        requested_ip: Option<Ipv4Addr>,
        server_id: Option<Ipv4Addr>,
    ) -> [u8; 300] {
        let mut pkt = [0u8; 300];
        pkt[0] = 1;
        pkt[1] = 1;
        pkt[2] = 6;
        pkt[4..8].copy_from_slice(&xid.to_be_bytes());
        // WHY: Broadcast flag lets dnsmasq answer on 255.255.255.255:68 before eth0 has an IPv4 address.
        pkt[10] = 0x80;
        pkt[28..34].copy_from_slice(&mac);
        pkt[236..240].copy_from_slice(&DHCP_MAGIC);

        let mut i = 240;
        pkt[i] = 53;
        pkt[i + 1] = 1;
        pkt[i + 2] = msg_type;
        i += 3;

        if let Some(ip) = requested_ip {
            pkt[i] = 50;
            pkt[i + 1] = 4;
            pkt[i + 2..i + 6].copy_from_slice(&ip.octets());
            i += 6;
        }
        if let Some(sid) = server_id {
            pkt[i] = 54;
            pkt[i + 1] = 4;
            pkt[i + 2..i + 6].copy_from_slice(&sid.octets());
            i += 6;
        }
        pkt[i] = 55;
        pkt[i + 1] = 3;
        pkt[i + 2] = 1;
        pkt[i + 3] = 3;
        pkt[i + 4] = 6;
        i += 5;

        pkt[i] = 255;
        pkt
    }

    struct ParsedDhcp {
        msg_type: u8,
        yiaddr: Ipv4Addr,
        server_id: Option<Ipv4Addr>,
        mask: Option<Ipv4Addr>,
        router: Option<Ipv4Addr>,
        dns: Vec<Ipv4Addr>,
    }

    fn parse_dhcp_reply(buf: &[u8], expected_xid: u32) -> Option<ParsedDhcp> {
        if buf.len() < 244 || buf[0] != 2 || buf[4..8] != expected_xid.to_be_bytes() {
            return None;
        }
        if buf[236..240] != DHCP_MAGIC {
            return None;
        }
        let yiaddr = Ipv4Addr::new(buf[16], buf[17], buf[18], buf[19]);
        let mut msg_type = 0u8;
        let mut server_id = None;
        let mut mask = None;
        let mut router = None;
        let mut dns = Vec::new();

        let mut i = 240;
        while i < buf.len() {
            let opt = buf[i];
            if opt == 255 {
                break;
            }
            if opt == 0 {
                i += 1;
                continue;
            }
            if i + 1 >= buf.len() {
                break;
            }
            let len = buf[i + 1] as usize;
            if i + 2 + len > buf.len() {
                break;
            }
            let val = &buf[i + 2..i + 2 + len];
            match opt {
                53 if len >= 1 => msg_type = val[0],
                54 if len == 4 => server_id = Some(Ipv4Addr::new(val[0], val[1], val[2], val[3])),
                1 if len == 4 => mask = Some(Ipv4Addr::new(val[0], val[1], val[2], val[3])),
                3 if len >= 4 => router = Some(Ipv4Addr::new(val[0], val[1], val[2], val[3])),
                6 => {
                    for chunk in val.chunks_exact(4) {
                        dns.push(Ipv4Addr::new(chunk[0], chunk[1], chunk[2], chunk[3]));
                    }
                }
                _ => {}
            }
            i += 2 + len;
        }
        if msg_type == 0 {
            return None;
        }
        if server_id.is_none() && (buf[20] | buf[21] | buf[22] | buf[23]) != 0 {
            server_id = Some(Ipv4Addr::new(buf[20], buf[21], buf[22], buf[23]));
        }
        Some(ParsedDhcp {
            msg_type,
            yiaddr,
            server_id,
            mask,
            router,
            dns,
        })
    }

    fn ipv4_header_checksum(hdr: &[u8]) -> u16 {
        let mut sum: u32 = 0;
        let mut i = 0;
        while i + 1 < hdr.len() {
            sum += u16::from_be_bytes([hdr[i], hdr[i + 1]]) as u32;
            i += 2;
        }
        while (sum >> 16) != 0 {
            sum = (sum & 0xffff) + (sum >> 16);
        }
        !(sum as u16)
    }

    fn wrap_ip_udp_dhcp(dhcp: &[u8; 300]) -> [u8; 328] {
        let mut pkt = [0u8; 328];
        let total_len: u16 = 328;
        pkt[0] = 0x45;
        pkt[2..4].copy_from_slice(&total_len.to_be_bytes());
        pkt[8] = 64;
        pkt[9] = 17;
        pkt[16..20].copy_from_slice(&[255, 255, 255, 255]);
        let csum = ipv4_header_checksum(&pkt[0..20]);
        pkt[10..12].copy_from_slice(&csum.to_be_bytes());

        let udp_len: u16 = 308;
        pkt[20..22].copy_from_slice(&68u16.to_be_bytes());
        pkt[22..24].copy_from_slice(&67u16.to_be_bytes());
        pkt[24..26].copy_from_slice(&udp_len.to_be_bytes());
        pkt[28..328].copy_from_slice(dhcp);
        pkt
    }

    fn extract_udp_dhcp_payload(ip_pkt: &[u8]) -> Option<&[u8]> {
        if ip_pkt.len() < 28 || (ip_pkt[0] >> 4) != 4 || ip_pkt[9] != 17 {
            return None;
        }
        let ihl = ((ip_pkt[0] & 0x0f) as usize) * 4;
        if ihl < 20 || ip_pkt.len() < ihl + 8 {
            return None;
        }
        let dst_port = u16::from_be_bytes([ip_pkt[ihl + 2], ip_pkt[ihl + 3]]);
        if dst_port != 68 {
            return None;
        }
        Some(&ip_pkt[ihl + 8..])
    }

    fn obtain_dhcp_lease(ifname: &str, mac: [u8; 6]) -> Option<DhcpLease> {
        let if_c = format!("{ifname}\0");
        let ifindex = unsafe { libc::if_nametoindex(if_c.as_ptr() as *const libc::c_char) };
        if ifindex == 0 {
            return None;
        }

        let eth_p_ip_be = (libc::ETH_P_IP as u16).to_be() as libc::c_int;
        let fd = unsafe { libc::socket(libc::AF_PACKET, libc::SOCK_DGRAM, eth_p_ip_be) };
        if fd < 0 {
            return None;
        }

        let tv = libc::timeval {
            tv_sec: 0,
            tv_usec: 600_000,
        };
        unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                &tv as *const libc::timeval as *const libc::c_void,
                mem::size_of::<libc::timeval>() as libc::socklen_t,
            );
        }

        let mut bind_addr: libc::sockaddr_ll = unsafe { mem::zeroed() };
        bind_addr.sll_family = libc::AF_PACKET as u16;
        bind_addr.sll_protocol = (libc::ETH_P_IP as u16).to_be();
        bind_addr.sll_ifindex = ifindex as libc::c_int;
        if unsafe {
            libc::bind(
                fd,
                &bind_addr as *const libc::sockaddr_ll as *const libc::sockaddr,
                mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t,
            )
        } != 0
        {
            unsafe {
                libc::close(fd);
            }
            return None;
        }

        let mut dst_addr: libc::sockaddr_ll = unsafe { mem::zeroed() };
        dst_addr.sll_family = libc::AF_PACKET as u16;
        dst_addr.sll_protocol = (libc::ETH_P_IP as u16).to_be();
        dst_addr.sll_ifindex = ifindex as libc::c_int;
        dst_addr.sll_halen = 6;
        dst_addr.sll_addr[0..6].copy_from_slice(&[0xff; 6]);

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(1);
        let xid = nanos ^ u32::from_be_bytes([mac[2], mac[3], mac[4], mac[5]]) ^ std::process::id();
        let mut buf = [0u8; 1600];

        let send_pkt = |raw: &[u8]| -> bool {
            let n = unsafe {
                libc::sendto(
                    fd,
                    raw.as_ptr() as *const libc::c_void,
                    raw.len(),
                    0,
                    &dst_addr as *const libc::sockaddr_ll as *const libc::sockaddr,
                    mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t,
                )
            };
            n == raw.len() as isize
        };

        let mut result = None;
        for _ in 0..3 {
            let discover = wrap_ip_udp_dhcp(&build_dhcp_packet(xid, mac, DHCP_DISCOVER, None, None));
            if !send_pkt(&discover) {
                continue;
            }
            let offer = loop {
                let n = unsafe { libc::recv(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
                if n <= 0 {
                    break None;
                }
                if let Some(payload) = extract_udp_dhcp_payload(&buf[..n as usize]) {
                    if let Some(parsed) = parse_dhcp_reply(payload, xid) {
                        if parsed.msg_type == DHCP_OFFER && !parsed.yiaddr.is_unspecified() {
                            break Some(parsed);
                        }
                    }
                }
            };
            let Some(offer) = offer else {
                continue;
            };

            let request = wrap_ip_udp_dhcp(&build_dhcp_packet(
                xid,
                mac,
                DHCP_REQUEST,
                Some(offer.yiaddr),
                offer.server_id,
            ));
            if !send_pkt(&request) {
                continue;
            }
            let ack = loop {
                let n = unsafe { libc::recv(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
                if n <= 0 {
                    break None;
                }
                if let Some(payload) = extract_udp_dhcp_payload(&buf[..n as usize]) {
                    if let Some(parsed) = parse_dhcp_reply(payload, xid) {
                        if parsed.msg_type == DHCP_ACK && !parsed.yiaddr.is_unspecified() {
                            break Some(parsed);
                        }
                    }
                }
            };
            if let Some(ack) = ack {
                let router = ack.router.or(offer.router);
                let mut dns = if !ack.dns.is_empty() { ack.dns } else { offer.dns };
                if dns.is_empty() {
                    if let Some(gw) = router {
                        dns.push(gw);
                    }
                }
                result = Some(DhcpLease {
                    ip: ack.yiaddr,
                    mask: ack.mask.or(offer.mask).unwrap_or(Ipv4Addr::new(255, 255, 255, 0)),
                    router,
                    dns,
                });
                break;
            }
        }
        unsafe {
            libc::close(fd);
        }
        result
    }

    fn apply_lease(sock_fd: libc::c_int, ifname: &str, lease: &DhcpLease) {
        let mut req = make_ifreq(ifname);
        req.ifr_ifru.ifru_addr = make_sockaddr_in(lease.ip);
        let _ = unsafe { libc::ioctl(sock_fd, libc::SIOCSIFADDR as _, &mut req) };

        let mut mask_req = make_ifreq(ifname);
        mask_req.ifr_ifru.ifru_netmask = make_sockaddr_in(lease.mask);
        let _ = unsafe { libc::ioctl(sock_fd, libc::SIOCSIFNETMASK as _, &mut mask_req) };

        if let Some(gw) = lease.router {
            let mut rt: libc::rtentry = unsafe { mem::zeroed() };
            rt.rt_dst = make_sockaddr_in(Ipv4Addr::UNSPECIFIED);
            rt.rt_genmask = make_sockaddr_in(Ipv4Addr::UNSPECIFIED);
            rt.rt_gateway = make_sockaddr_in(gw);
            rt.rt_flags = (libc::RTF_UP | libc::RTF_GATEWAY) as u16;
            let mut dev_bytes: Vec<libc::c_char> = ifname.bytes().map(|b| b as libc::c_char).collect();
            dev_bytes.push(0);
            rt.rt_dev = dev_bytes.as_mut_ptr();
            let _ = unsafe { libc::ioctl(sock_fd, libc::SIOCADDRT as _, &mut rt) };
        }

        if !lease.dns.is_empty() {
            let _ = fs::create_dir_all("/etc");
            if fs::symlink_metadata("/etc/resolv.conf")
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                let _ = fs::remove_file("/etc/resolv.conf");
            }
            let mut content = String::new();
            for ns in &lease.dns {
                content.push_str(&format!("nameserver {ns}\n"));
            }
            let _ = fs::write("/etc/resolv.conf", content);
        }
    }

    pub fn configure_network() {
        let _ = fs::create_dir_all("/etc");
        if !std::path::Path::new("/etc/hosts").exists() {
            let _ = fs::write("/etc/hosts", "127.0.0.1 localhost\n::1 localhost\n");
        }

        let sock_fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
        if sock_fd < 0 {
            return;
        }
        let _ = bring_interface_up(sock_fd, "lo");
        if bring_interface_up(sock_fd, "eth0") {
            if let Some(mac) = get_mac(sock_fd, "eth0") {
                if let Some(lease) = obtain_dhcp_lease("eth0", mac) {
                    apply_lease(sock_fd, "eth0", &lease);
                } else {
                    eprintln!("qorpera-oci-init: dhcp lease on eth0 timed out; continuing");
                }
            }
        }
        unsafe {
            libc::close(sock_fd);
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod linux_net {
    pub fn configure_network() {}
}

#[cfg(unix)]
mod unix_exec {
    use super::OciInitSpec;
    use std::ffi::OsStr;
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::process::{self, Command};
    use std::sync::atomic::{AtomicI32, Ordering};

    static CHILD_PID: AtomicI32 = AtomicI32::new(0);
    static PENDING_SIGNAL: AtomicI32 = AtomicI32::new(0);

    extern "C" fn handle_signal(sig: libc::c_int) {
        PENDING_SIGNAL.store(sig, Ordering::SeqCst);
        let pid = CHILD_PID.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe {
                libc::kill(pid, sig);
            }
        }
    }

    fn lookup_passwd_user(name_or_uid: &str) -> Option<(u32, u32, Option<String>)> {
        let numeric = name_or_uid.parse::<u32>().ok();
        let content = fs::read_to_string("/etc/passwd").ok();
        if let Some(text) = content {
            for line in text.lines() {
                let parts: Vec<&str> = line.split(':').collect();
                if parts.len() < 6 {
                    continue;
                }
                let Ok(uid) = parts[2].parse::<u32>() else {
                    continue;
                };
                let Ok(gid) = parts[3].parse::<u32>() else {
                    continue;
                };
                let home = if parts[5].is_empty() {
                    None
                } else {
                    Some(parts[5].to_string())
                };
                if let Some(target_uid) = numeric {
                    if uid == target_uid {
                        return Some((uid, gid, home));
                    }
                } else if parts[0] == name_or_uid {
                    return Some((uid, gid, home));
                }
            }
        }
        numeric.map(|uid| (uid, uid, None))
    }

    fn lookup_group(name_or_gid: &str) -> Option<u32> {
        if let Ok(gid) = name_or_gid.parse::<u32>() {
            return Some(gid);
        }
        let content = fs::read_to_string("/etc/group").ok()?;
        for line in content.lines() {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 3 && parts[0] == name_or_gid {
                return parts[2].parse::<u32>().ok();
            }
        }
        None
    }

    fn resolve_user_spec(spec: &str) -> Option<(u32, u32, Option<String>)> {
        let trimmed = spec.trim();
        if trimmed.is_empty() || trimmed == "0" || trimmed == "root" || trimmed == "0:0" {
            return None;
        }
        let (user_part, group_part) = match trimmed.split_once(':') {
            Some((u, g)) => (u.trim(), Some(g.trim()).filter(|s| !s.is_empty())),
            None => (trimmed, None),
        };
        let (uid, mut gid, home) = lookup_passwd_user(user_part)?;
        if let Some(gp) = group_part {
            if let Some(resolved_gid) = lookup_group(gp) {
                gid = resolved_gid;
            }
        }
        if uid == 0 && gid == 0 {
            return None;
        }
        Some((uid, gid, home))
    }

    pub fn run_child(spec: &OciInitSpec, argv: &[String], workdir: &str) -> ! {
        let creds = resolve_user_spec(&spec.user);
        if let Some((_, _, Some(ref home))) = creds {
            if std::env::var_os("HOME").is_none() {
                std::env::set_var("HOME", home);
            }
        }

        unsafe {
            libc::signal(libc::SIGTERM, handle_signal as *const () as libc::sighandler_t);
            libc::signal(libc::SIGINT, handle_signal as *const () as libc::sighandler_t);
            libc::signal(libc::SIGHUP, handle_signal as *const () as libc::sighandler_t);
        }

        let mut cmd = Command::new(OsStr::new(&argv[0]));
        cmd.args(&argv[1..]);
        cmd.current_dir(workdir);
        if let Some((uid, gid, _)) = creds {
            unsafe {
                cmd.pre_exec(move || {
                    if libc::setgroups(0, std::ptr::null()) != 0 {
                        let err = std::io::Error::last_os_error();
                        if err.raw_os_error() != Some(libc::EPERM) {
                            return Err(err);
                        }
                    }
                    if libc::setgid(gid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setuid(uid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                eprintln!("qorpera-oci-init: failed to spawn {:?}: {err}", argv[0]);
                process::exit(127);
            }
        };

        let child_pid = child.id() as libc::pid_t;
        CHILD_PID.store(child_pid, Ordering::SeqCst);
        let pending = PENDING_SIGNAL.swap(0, Ordering::SeqCst);
        if pending != 0 {
            unsafe {
                libc::kill(child_pid, pending);
            }
        }

        loop {
            let mut status: libc::c_int = 0;
            let waited = unsafe { libc::waitpid(-1, &mut status, 0) };
            if waited == child_pid {
                let code = if libc::WIFEXITED(status) {
                    libc::WEXITSTATUS(status)
                } else if libc::WIFSIGNALED(status) {
                    128 + libc::WTERMSIG(status)
                } else {
                    1
                };
                process::exit(code);
            }
            if waited < 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EINTR) {
                    let sig = PENDING_SIGNAL.swap(0, Ordering::SeqCst);
                    if sig != 0 {
                        unsafe {
                            libc::kill(child_pid, sig);
                        }
                    }
                    continue;
                }
                if err.raw_os_error() == Some(libc::ECHILD) {
                    process::exit(0);
                }
                process::exit(1);
            }
        }
    }
}

fn main() {
    linux_net::configure_network();

    let raw = match fs::read_to_string("/etc/qorpera-oci-init.json") {
        Ok(s) => s,
        Err(err) => {
            eprintln!("qorpera-oci-init: failed reading /etc/qorpera-oci-init.json: {err}");
            process::exit(126);
        }
    };
    let spec: OciInitSpec = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("qorpera-oci-init: invalid /etc/qorpera-oci-init.json: {err}");
            process::exit(126);
        }
    };

    for kv in &spec.env {
        if let Some((k, v)) = kv.split_once('=') {
            if !k.is_empty() && env::var_os(k).is_none() {
                env::set_var(k, v);
            }
        }
    }
    if env::var_os("PATH").is_none() {
        env::set_var(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        );
    }

    let mut argv = Vec::with_capacity(spec.entrypoint.len() + spec.cmd.len());
    argv.extend(spec.entrypoint.iter().cloned());
    argv.extend(spec.cmd.iter().cloned());
    if argv.is_empty() {
        eprintln!("qorpera-oci-init: empty entrypoint and cmd");
        process::exit(127);
    }

    let workdir = if spec.workdir.trim().is_empty() || !Path::new(&spec.workdir).is_dir() {
        "/"
    } else {
        spec.workdir.trim()
    };

    #[cfg(unix)]
    unix_exec::run_child(&spec, &argv, workdir);

    #[cfg(not(unix))]
    {
        let status = Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(workdir)
            .status()
            .map(|s| s.code().unwrap_or(1))
            .unwrap_or(127);
        process::exit(status);
    }
}
