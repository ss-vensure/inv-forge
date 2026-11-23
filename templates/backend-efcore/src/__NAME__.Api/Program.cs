using __NAME__.Api.Endpoints;
using __NAME__.Application;
using __NAME__.Application.Status;
using __NAME__.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

// Set with `dotnet user-secrets` locally and an environment variable when deployed. Never in the repository.
var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("ConnectionStrings:Default is not configured.");

builder.Services
    .AddApplication()
    .AddInfrastructure(connectionString)
    .AddSingleton(new ServiceInfo("__SLUG__", typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0"));

var app = builder.Build();

// Everything is served under the tool's route slug, the path the gateway forwards.
var api = app.MapGroup("/__SLUG__/api");
api.MapStatusEndpoints();

await app.RunAsync();
