import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

const apiUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'http://10.0.2.2:3000',
);
const brand = Color(0xff0b6b62);
final storage = FlutterSecureStorage();

class Api {
  String? token;
  Future<Map<String, dynamic>> req(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    final h = {
      'content-type': 'application/json',
      if (token != null) 'authorization': 'Bearer $token',
    };
    final r = method == 'GET'
        ? await http.get(Uri.parse('$apiUrl$path'), headers: h)
        : await http.post(
            Uri.parse('$apiUrl$path'),
            headers: h,
            body: jsonEncode(body ?? {}),
          );
    final d = r.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode >= 400)
      throw Exception(d['error'] ?? 'HTTP_${r.statusCode}');
    return d;
  }

  Future<void> load() async => token = await storage.read(key: 'token');
  Future<void> save(String x) async {
    token = x;
    await storage.write(key: 'token', value: x);
  }

  Future<void> logout() async {
    token = null;
    await storage.delete(key: 'token');
  }
}

final api = Api();
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await api.load();
  runApp(const DriverApp());
}

class DriverApp extends StatelessWidget {
  const DriverApp({super.key});
  @override
  Widget build(BuildContext c) => MaterialApp(
    debugShowCheckedModeBanner: false,
    title: 'San Martín Conductor',
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: brand),
    ),
    home: api.token == null ? const Login() : const DriverHome(),
  );
}

class Login extends StatefulWidget {
  const Login({super.key});
  @override
  State<Login> createState() => _Login();
}

class _Login extends State<Login> {
  final phone = TextEditingController(),
      pass = TextEditingController(),
      name = TextEditingController();
  bool reg = false, busy = false;
  Future<void> go() async {
    setState(() => busy = true);
    try {
      final d = await api.req(
        reg ? '/api/v1/auth/register' : '/api/v1/auth/login',
        method: 'POST',
        body: reg
            ? {
                'phone': phone.text,
                'name': name.text,
                'password': pass.text,
                'role': 'DRIVER',
              }
            : {'phone': phone.text, 'password': pass.text},
      );
      await api.save(d['token']);
      if (mounted)
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => const DriverHome()),
        );
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext c) => Scaffold(
    body: Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.local_taxi, size: 58, color: brand),
                const Text(
                  'San Martín Conductor',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: brand,
                  ),
                ),
                const SizedBox(height: 24),
                if (reg)
                  TextField(
                    controller: name,
                    decoration: const InputDecoration(labelText: 'Nombre'),
                  ),
                TextField(
                  controller: phone,
                  decoration: const InputDecoration(labelText: 'Teléfono'),
                ),
                TextField(
                  controller: pass,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Contraseña'),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: busy ? null : go,
                  child: Text(reg ? 'Crear cuenta' : 'Ingresar'),
                ),
                TextButton(
                  onPressed: () => setState(() => reg = !reg),
                  child: Text(
                    reg ? 'Volver al login' : 'Registrarme como conductor',
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class DriverHome extends StatefulWidget {
  const DriverHome({super.key});
  @override
  State<DriverHome> createState() => _DriverHome();
}

class _DriverHome extends State<DriverHome> {
  io.Socket? socket;
  Map<String, dynamic>? status, offer, ride;
  LatLng? pos;
  @override
  void initState() {
    super.initState();
    connect();
    refresh();
  }

  void connect() {
    socket = io.io(
      apiUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': api.token})
          .enableReconnection()
          .build(),
    );
    socket!.on('ride:offer', (d) {
      if (mounted) setState(() => offer = Map<String, dynamic>.from(d));
    });
    socket!.on('ride:status', (d) {
      if (mounted) setState(() => ride = Map<String, dynamic>.from(d));
    });
  }

  Future<void> refresh() async {
    try {
      final s = await api.req('/api/v1/drivers/status');
      if (mounted) setState(() => status = s);
    } catch (e) {
      toast(e);
    }
  }

  Future<void> gps() async {
    if (!await Geolocator.isLocationServiceEnabled()) return;
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied)
      p = await Geolocator.requestPermission();
    if (p == LocationPermission.denied || p == LocationPermission.deniedForever)
      return;
    final x = await Geolocator.getCurrentPosition();
    pos = LatLng(x.latitude, x.longitude);
    await api.req(
      '/api/v1/drivers/location',
      method: 'POST',
      body: {
        'lat': x.latitude,
        'lng': x.longitude,
        if (ride?['id'] != null) 'rideId': ride!['id'],
      },
    );
    if (mounted) setState(() {});
  }

  Future<void> availability(bool value) async {
    try {
      await gps();
      await api.req(
        '/api/v1/drivers/availability',
        method: 'POST',
        body: {'available': value, 'lat': pos?.latitude, 'lng': pos?.longitude},
      );
      await refresh();
    } catch (e) {
      toast(e);
    }
  }

  Future<void> accept() async {
    try {
      ride = await api.req(
        '/api/v1/rides/${offer!['rideId']}/accept',
        method: 'POST',
      );
      socket?.emit('ride:join', ride!['id']);
      setState(() => offer = null);
    } catch (e) {
      toast(e);
    }
  }

  Future<void> state(String s) async {
    try {
      ride = await api.req(
        '/api/v1/rides/${ride!['id']}/status',
        method: 'POST',
        body: {'status': s},
      );
      setState(() {});
    } catch (e) {
      toast(e);
    }
  }

  void toast(Object e) {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
  }

  @override
  void dispose() {
    socket?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext c) {
    final center = pos ?? const LatLng(-6.034, -76.972);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Panel del conductor'),
        actions: [
          IconButton(
            onPressed: () {
              api.logout();
              Navigator.pushReplacement(
                c,
                MaterialPageRoute(builder: (_) => const Login()),
              );
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: FlutterMap(
              options: MapOptions(initialCenter: center, initialZoom: 14),
              children: [
                TileLayer(
                  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'pe.sanmartin.transporte.driver',
                ),
                MarkerLayer(
                  markers: [
                    if (pos != null)
                      Marker(
                        point: pos!,
                        child: const Icon(
                          Icons.local_taxi,
                          color: brand,
                          size: 34,
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
          if (status != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Card(
                child: ListTile(
                  title: Text(
                    status!['available'] == true
                        ? 'Disponible para recibir viajes'
                        : 'No disponible',
                  ),
                  subtitle: Text(
                    (status!['reasons'] as List?)?.join(', ') ??
                        'Estado operativo',
                  ),
                  trailing: Switch(
                    value: status!['available'] == true,
                    onChanged: availability,
                  ),
                ),
              ),
            ),
          if (offer != null)
            OfferCard(
              offer: offer!,
              accept: accept,
              reject: () => setState(() => offer = null),
            ),
          if (ride != null) RideCard(ride: ride!, next: state),
        ],
      ),
    );
  }
}

class OfferCard extends StatelessWidget {
  final Map<String, dynamic> offer;
  final VoidCallback accept, reject;
  const OfferCard({
    super.key,
    required this.offer,
    required this.accept,
    required this.reject,
  });
  @override
  Widget build(BuildContext c) => Card(
    color: Colors.amber.shade50,
    margin: const EdgeInsets.all(16),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Nueva solicitud',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          ),
          Text('Tarifa estimada: S/ ${offer['estimatedFare']}'),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: reject,
                  child: const Text('Rechazar'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton(
                  onPressed: accept,
                  child: const Text('Aceptar'),
                ),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

class RideCard extends StatelessWidget {
  final Map<String, dynamic> ride;
  final Future<void> Function(String) next;
  const RideCard({super.key, required this.ride, required this.next});
  @override
  Widget build(BuildContext c) {
    final s = ride['status'];
    final n = {
      'MATCHED': 'DRIVER_ARRIVING',
      'DRIVER_ARRIVING': 'DRIVER_WAITING',
      'DRIVER_WAITING': 'IN_PROGRESS',
      'IN_PROGRESS': 'COMPLETED',
    };
    final l = {
      'MATCHED': 'Ir al origen',
      'DRIVER_ARRIVING': 'Marcar llegada',
      'DRIVER_WAITING': 'Iniciar viaje',
      'IN_PROGRESS': 'Finalizar viaje',
    };
    return Card(
      margin: const EdgeInsets.all(16),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Viaje $s',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            if (n[s] != null)
              FilledButton(onPressed: () => next(n[s]!), child: Text(l[s]!)),
            if (s == 'COMPLETED')
              const Text('Viaje finalizado. El pasajero puede calificar.'),
          ],
        ),
      ),
    );
  }
}
