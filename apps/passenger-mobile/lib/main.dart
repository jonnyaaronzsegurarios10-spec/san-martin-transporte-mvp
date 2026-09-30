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
final store = FlutterSecureStorage();

class Api {
  String? token;
  Future<Map<String, dynamic>> call(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final headers = {
      'content-type': 'application/json',
      if (token != null) 'authorization': 'Bearer $token',
    };
    final response = body == null
        ? await http.get(Uri.parse('$apiUrl$path'), headers: headers)
        : await http.post(
            Uri.parse('$apiUrl$path'),
            headers: headers,
            body: jsonEncode(body),
          );
    final raw = response.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(response.body);
    if (response.statusCode >= 400)
      throw Exception(raw['error'] ?? 'HTTP ${response.statusCode}');
    return Map<String, dynamic>.from(raw);
  }

  Future<void> load() async => token = await store.read(key: 'token');
  Future<void> save(String value) async {
    token = value;
    await store.write(key: 'token', value: value);
  }

  Future<void> logout() async {
    token = null;
    await store.delete(key: 'token');
  }
}

final api = Api();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await api.load();
  runApp(const App());
}

class App extends StatelessWidget {
  const App({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'San Martín Transporte',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: brand),
    ),
    home: api.token == null ? const LoginPage() : const HomePage(),
  );
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final phone = TextEditingController(),
      password = TextEditingController(),
      name = TextEditingController();
  bool register = false, busy = false;
  Future<void> submit() async {
    setState(() => busy = true);
    try {
      final data = await api.call(
        register ? '/api/v1/auth/register' : '/api/v1/auth/login',
        body: register
            ? {
                'phone': phone.text,
                'name': name.text,
                'password': password.text,
                'role': 'PASSENGER',
              }
            : {'phone': phone.text, 'password': password.text},
      );
      await api.save(data['token']);
      if (mounted)
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => const HomePage()),
        );
    } catch (error) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.route, size: 58, color: brand),
                const SizedBox(height: 12),
                const Text(
                  'San Martín Transporte',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: brand,
                  ),
                ),
                const SizedBox(height: 24),
                if (register)
                  TextField(
                    controller: name,
                    decoration: const InputDecoration(labelText: 'Nombre'),
                  ),
                TextField(
                  controller: phone,
                  decoration: const InputDecoration(labelText: 'Teléfono'),
                ),
                TextField(
                  controller: password,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Contraseña'),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: busy ? null : submit,
                  child: Text(register ? 'Crear cuenta' : 'Iniciar sesión'),
                ),
                TextButton(
                  onPressed: () => setState(() => register = !register),
                  child: Text(
                    register ? 'Ya tengo una cuenta' : 'Crear cuenta nueva',
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

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  LatLng? pickup, destination;
  Map<String, dynamic>? estimate, ride;
  io.Socket? socket;
  String city = 'Moyobamba', payment = 'CASH';
  @override
  void initState() {
    super.initState();
    _connect();
    _locate();
  }

  void _connect() {
    socket = io.io(
      apiUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': api.token})
          .enableReconnection()
          .build(),
    );
    socket!.on('ride:status', (data) {
      if (mounted) setState(() => ride = Map<String, dynamic>.from(data));
    });
  }

  Future<void> _locate() async {
    if (!await Geolocator.isLocationServiceEnabled()) return;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied)
      permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever)
      return;
    final p = await Geolocator.getCurrentPosition();
    if (mounted) setState(() => pickup = LatLng(p.latitude, p.longitude));
  }

  Future<void> _estimate() async {
    if (pickup == null || destination == null) return;
    try {
      final d = await api.call(
        '/api/v1/rides/estimate',
        body: {
          'city': city,
          'pickupLat': pickup!.latitude,
          'pickupLng': pickup!.longitude,
          'destinationLat': destination!.latitude,
          'destinationLng': destination!.longitude,
        },
      );
      setState(() => estimate = d);
    } catch (e) {
      _toast(e);
    }
  }

  Future<void> _request() async {
    if (pickup == null || destination == null) return;
    try {
      final d = await api.call(
        '/api/v1/rides',
        body: {
          'city': city,
          'pickupLat': pickup!.latitude,
          'pickupLng': pickup!.longitude,
          'destinationLat': destination!.latitude,
          'destinationLng': destination!.longitude,
          'paymentMethod': payment,
        },
      );
      setState(() => ride = d);
      socket?.emit('ride:join', d['id']);
    } catch (e) {
      _toast(e);
    }
  }

  void _toast(Object e) {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
  }

  @override
  void dispose() {
    socket?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final center = pickup ?? const LatLng(-6.034, -76.972);
    return Scaffold(
      appBar: AppBar(
        title: const Text('San Martín Transporte'),
        actions: [
          IconButton(
            onPressed: () async {
              await api.logout();
              if (context.mounted)
                Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(builder: (_) => const LoginPage()),
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
              options: MapOptions(
                initialCenter: center,
                initialZoom: 14,
                onTap: (_, point) => setState(() => destination = point),
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'pe.sanmartin.transporte.passenger',
                ),
                MarkerLayer(
                  markers: [
                    if (pickup != null)
                      Marker(
                        point: pickup!,
                        child: const Icon(
                          Icons.my_location,
                          color: brand,
                          size: 32,
                        ),
                      ),
                    if (destination != null)
                      Marker(
                        point: destination!,
                        child: const Icon(
                          Icons.location_pin,
                          color: Colors.red,
                          size: 40,
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
          if (ride != null) _RideCard(ride: ride!),
          if (ride == null)
            _RequestPanel(
              city: city,
              payment: payment,
              estimate: estimate,
              destinationSelected: destination != null,
              onCity: (v) => setState(() => city = v),
              onPayment: (v) => setState(() => payment = v),
              onEstimate: _estimate,
              onRequest: _request,
            ),
        ],
      ),
    );
  }
}

class _RequestPanel extends StatelessWidget {
  final String city, payment;
  final Map<String, dynamic>? estimate;
  final bool destinationSelected;
  final ValueChanged<String> onCity, onPayment;
  final VoidCallback onEstimate, onRequest;
  const _RequestPanel({
    required this.city,
    required this.payment,
    required this.estimate,
    required this.destinationSelected,
    required this.onCity,
    required this.onPayment,
    required this.onEstimate,
    required this.onRequest,
  });
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    color: Colors.white,
    child: Column(
      children: [
        Row(
          children: [
            Expanded(
              child: DropdownButtonFormField(
                value: city,
                items:
                    [
                          'Moyobamba',
                          'Tarapoto',
                          'Nueva Cajamarca',
                          'Rioja',
                          'Soritor',
                        ]
                        .map((x) => DropdownMenuItem(value: x, child: Text(x)))
                        .toList(),
                onChanged: (v) => onCity(v!),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: DropdownButtonFormField(
                value: payment,
                items: const [
                  DropdownMenuItem(value: 'CASH', child: Text('Efectivo')),
                  DropdownMenuItem(value: 'YAPE', child: Text('Yape')),
                  DropdownMenuItem(value: 'PLIN', child: Text('Plin')),
                  DropdownMenuItem(
                    value: 'TRANSFER',
                    child: Text('Transferencia'),
                  ),
                ],
                onChanged: (v) => onPayment(v!),
              ),
            ),
          ],
        ),
        Text(
          destinationSelected
              ? 'Destino seleccionado'
              : 'Toca el mapa para elegir destino',
        ),
        if (estimate != null)
          Text(
            'Estimado: S/ ${estimate!['fare']}',
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          ),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: onEstimate,
                child: const Text('Estimar precio'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: FilledButton(
                onPressed: estimate == null ? null : onRequest,
                child: const Text('Solicitar viaje'),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}

class _RideCard extends StatelessWidget {
  final Map<String, dynamic> ride;
  const _RideCard({required this.ride});
  @override
  Widget build(BuildContext context) {
    const labels = {
      'SEARCHING': 'Buscando conductor',
      'MATCHED': 'Conductor asignado',
      'DRIVER_ARRIVING': 'Conductor acercándose',
      'DRIVER_WAITING': 'Conductor llegó',
      'IN_PROGRESS': 'Viaje activo',
      'COMPLETED': 'Viaje terminado',
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(18),
      color: Colors.white,
      child: Text(
        labels[ride['status']] ?? '${ride['status']}',
        style: Theme.of(context).textTheme.titleLarge,
      ),
    );
  }
}
